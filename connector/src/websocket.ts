import type { ConnectorConfig } from './config.ts'
import { CONNECTOR_PROTOCOL_VERSION, type ExecutionRequest, type ServerToConnector } from './protocol.ts'
import { LocalCodexExecutor } from './codex.ts'

function websocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/connector'
  url.search = ''
  return url.toString()
}

export async function runConnector(config: ConnectorConfig, deviceToken: string, executor: LocalCodexExecutor): Promise<never> {
  let delay = 1_000
  while (true) {
    try {
      await connectOnce(config, deviceToken, executor)
      delay = 1_000
    } catch (error: any) {
      console.error(`[connector] ${error?.message || 'connection failed'}; retrying in ${Math.round(delay / 1000)}s`)
    }
    await Bun.sleep(delay)
    delay = Math.min(delay * 2, 30_000)
  }
}

function connectOnce(config: ConnectorConfig, deviceToken: string, executor: LocalCodexExecutor): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(websocketUrl(config.serverUrl))
    let authenticated = false
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
        console.log(`[connector] connected as device "${config.deviceName}"`)
        const seconds = Math.max(10, message.heartbeat_interval || 30)
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', sent_at: new Date().toISOString() }))
        }, seconds * 1_000)
        return
      }
      if (message.type !== 'execution_request') return
      const request = message as ExecutionRequest
      try {
        const result = await executor.execute(request)
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
          type: 'execution_result', request_id: request.request_id, status: 'success', content: result.content, usage: result.usage,
        }))
      } catch (error: any) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
          type: 'execution_result', request_id: request.request_id, status: 'error', error: error?.message || 'Codex execution failed',
        }))
      }
    })
    ws.addEventListener('error', () => { if (!authenticated) reject(new Error('unable to connect to AI Studio Server')) })
    ws.addEventListener('close', () => {
      if (heartbeat) clearInterval(heartbeat)
      resolve()
    })
  })
}

