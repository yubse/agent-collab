import type { ConnectorConfig } from '../config/index.ts'
import { CONNECTOR_PROTOCOL_VERSION, type ExecutionRequest, type ServerToConnector } from '../protocol.ts'
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
  deviceToken: string,
  runner: ExecutionRunner,
  state: ConnectorStateStore,
): Promise<never> {
  let delay = 1_000
  while (true) {
    try {
      await connectOnce(config, deviceToken, runner, state)
      delay = 1_000
    } catch (error: any) {
      const message = error?.message || 'connection failed'
      state.setServer('SERVER_DISCONNECTED', message)
      console.error(`[connector] status=SERVER_DISCONNECTED error=${connectionErrorCode(message)} retry=${Math.round(delay / 1000)}s`)
    }
    await Bun.sleep(delay)
    delay = Math.min(delay * 2, 30_000)
  }
}

export function connectOnce(
  config: ConnectorConfig,
  deviceToken: string,
  runner: ExecutionRunner,
  state: ConnectorStateStore,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(resolveWebsocketUrl(config))
    let authenticated = false
    let settledOpen = false
    let heartbeat: ReturnType<typeof setInterval> | null = null
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        protocol_version: CONNECTOR_PROTOCOL_VERSION,
        device_token: deviceToken,
        device_name: config.deviceName,
      }))
    })
    ws.addEventListener('message', async (event) => {
      let message: ServerToConnector
      try { message = JSON.parse(String(event.data)) } catch { ws.close(); return }
      if (message.type === 'hello_ack') {
        if (message.status !== 'ok') { reject(new Error(message.error || 'connector authentication failed')); ws.close(); return }
        authenticated = true
        settledOpen = true
        state.setServer('SERVER_CONNECTED')
        console.log(`[connector] status=SERVER_CONNECTED device="${config.deviceName}"`)
        const seconds = Math.max(10, message.heartbeat_interval || 30)
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', sent_at: new Date().toISOString() }))
        }, seconds * 1_000)
        return
      }
      if (message.type !== 'execution_request') return
      const result = await runner.run(message as ExecutionRequest)
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result))
    })
    ws.addEventListener('error', () => {
      if (!authenticated) reject(new Error('unable to connect to AI Studio Server'))
    })
    ws.addEventListener('close', () => {
      if (heartbeat) clearInterval(heartbeat)
      state.setServer('SERVER_DISCONNECTED')
      if (settledOpen) resolve()
      else reject(new Error('AI Studio Server closed the connection before authentication'))
    })
  })
}

function connectionErrorCode(message: string): string {
  if (/authentication|device token|before authentication/i.test(message)) return 'CONNECTOR_AUTH_FAILED'
  return 'SERVER_CONNECTION_FAILED'
}
