import type { ConnectorConfig } from '../config/index.ts'
import {
  CONNECTOR_PROTOCOL_VERSION,
  type ExecutionAck,
  type ExecutionRequest,
  type ServerToConnector,
} from '../protocol.ts'
import type { ExecutionRunner } from '../execution/runner.ts'
import type { ConnectorStateStore } from '../state/store.ts'

export function resolveWebsocketUrl(config: ConnectorConfig): string {
  if (config.connectorWsUrl) {
    const explicit = new URL(config.connectorWsUrl)
    if (explicit.protocol !== 'ws:' && explicit.protocol !== 'wss:') throw new Error('CONNECTOR_WS_URL must use ws:// or wss://')
    return explicit.toString()
  }
  const url = new URL(config.serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/connector'
  url.search = ''
  return url.toString()
}

export async function runConnector(
  config: ConnectorConfig,
  deviceToken: string | (() => string),
  runner: ExecutionRunner,
  state: ConnectorStateStore,
  signal?: AbortSignal,
): Promise<void> {
  let delay = 1_000
  while (!signal?.aborted) {
    try {
      const currentDeviceToken = typeof deviceToken === 'function' ? deviceToken() : deviceToken
      if (!currentDeviceToken) throw new Error('CONNECTOR_NOT_BOUND')
      await connectOnce(config, currentDeviceToken, runner, state, signal)
      delay = 1_000
    } catch (error: any) {
      if (signal?.aborted) break
      const message = error?.message || 'connection failed'
      state.setServer('SERVER_DISCONNECTED', message)
      console.error(`[connector] status=SERVER_DISCONNECTED error=${connectionErrorCode(message)} retry=${Math.round(delay / 1000)}s`)
    }
    if (signal?.aborted) break
    await sleepUntil(delay, signal)
    delay = Math.min(delay * 2, 30_000)
  }
  state.setServer('SERVER_DISCONNECTED')
}

export function connectOnce(
  config: ConnectorConfig,
  deviceToken: string,
  runner: ExecutionRunner,
  state: ConnectorStateStore,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('CONNECTOR_ABORTED')); return }
    const ws = new WebSocket(resolveWebsocketUrl(config))
    let authenticated = false
    let settledOpen = false
    let heartbeat: ReturnType<typeof setInterval> | null = null
    const attachedRequests = new Set<string>()
    const onAbort = () => {
      ws.close(4004, 'device unbound')
      if (!settledOpen) reject(new Error('CONNECTOR_ABORTED'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const connectTimer = setTimeout(() => {
      if (authenticated) return
      reject(new Error('CONNECT_TIMEOUT'))
      ws.close()
    }, config.connectTimeoutMs)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        protocol_version: CONNECTOR_PROTOCOL_VERSION,
        device_token: deviceToken,
        device_name: config.deviceName,
      }))
    })
    ws.addEventListener('message', (event) => {
      let message: ServerToConnector
      try { message = JSON.parse(String(event.data)) } catch { ws.close(); return }
      if (message.type === 'hello_ack') {
        if (message.status !== 'ok') { reject(new Error(message.error || 'connector authentication failed')); ws.close(); return }
        authenticated = true
        settledOpen = true
        clearTimeout(connectTimer)
        state.setServer('SERVER_CONNECTED')
        console.log(`[connector] status=SERVER_CONNECTED device="${config.deviceName}"`)
        const seconds = Math.max(1, message.heartbeat_interval || 30)
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', sent_at: new Date().toISOString() }))
        }, seconds * 1_000)
        return
      }
      if (message.type !== 'execution_request') return
      const request = message as ExecutionRequest
      runner.receive(request)
      const acknowledgedAt = new Date().toISOString()
      const ack: ExecutionAck = {
        type: 'execution_ack',
        request_id: request.request_id,
        status: 'running',
        acknowledged_at: acknowledgedAt,
      }
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(ack))
      runner.acknowledge(request.request_id, acknowledgedAt)

      // Keep model work outside the WebSocket message callback. Heartbeats continue on
      // their own timer, and a duplicate request_id reuses the same promise instead of
      // launching a second Codex turn.
      if (attachedRequests.has(request.request_id)) return
      attachedRequests.add(request.request_id)
      void runner.start(request).then((result) => {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify(result))
        const at = result.timings?.execution_result_at || new Date().toISOString()
        console.log(`[execution] request=${safeId(request.request_id)} state=result_sent at=${at}`)
      })
    })
    ws.addEventListener('error', () => {
      if (!authenticated) {
        clearTimeout(connectTimer)
        reject(new Error('unable to connect to AI Studio Server'))
      }
    })
    ws.addEventListener('close', () => {
      clearTimeout(connectTimer)
      if (heartbeat) clearInterval(heartbeat)
      signal?.removeEventListener('abort', onAbort)
      state.setServer('SERVER_DISCONNECTED')
      if (settledOpen) resolve()
      else reject(new Error('AI Studio Server closed the connection before authentication'))
    })
  })
}

function sleepUntil(delay: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(delay)
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, delay)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || 'unknown'
}

function connectionErrorCode(message: string): string {
  if (/authentication|device token|before authentication/i.test(message)) return 'CONNECTOR_AUTH_FAILED'
  return 'SERVER_CONNECTION_FAILED'
}
