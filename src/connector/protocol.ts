export const CONNECTOR_PROTOCOL_VERSION = 1 as const

export type ConnectorHello = {
  type: 'hello'
  protocol_version: 1
  device_token: string
  device_name: string
}

export type ConnectorHelloAck = {
  type: 'hello_ack'
  status: 'ok' | 'error'
  user_id?: string
  heartbeat_interval?: number
  error?: string
}

export type ConnectorHeartbeat = { type: 'heartbeat'; sent_at: string }
export type ConnectorHeartbeatAck = { type: 'heartbeat_ack'; received_at: string }

export type ExecutionRequest = {
  type: 'execution_request'
  request_id: string
  user_id: string
  conversation_id: string
  agent_id: string
  prompt: string
  created_at: string
}

export type ExecutionResult = {
  type: 'execution_result'
  request_id: string
  status: 'success' | 'error'
  content?: string
  usage?: Record<string, number> | null
  error?: string
}

export type ConnectorToServer = ConnectorHello | ConnectorHeartbeat | ExecutionResult
export type ServerToConnector = ConnectorHelloAck | ConnectorHeartbeatAck | ExecutionRequest

export function parseConnectorMessage(raw: string): ConnectorToServer {
  let value: any
  try { value = JSON.parse(raw) } catch { throw new Error('invalid JSON') }
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') throw new Error('message type required')
  if (value.type === 'hello') {
    if (value.protocol_version !== CONNECTOR_PROTOCOL_VERSION) throw new Error('unsupported protocol version')
    if (typeof value.device_token !== 'string' || !value.device_token) throw new Error('device_token required')
    if (typeof value.device_name !== 'string' || !value.device_name.trim()) throw new Error('device_name required')
    return value as ConnectorHello
  }
  if (value.type === 'heartbeat') return { type: 'heartbeat', sent_at: String(value.sent_at || '') }
  if (value.type === 'execution_result') {
    if (typeof value.request_id !== 'string' || !value.request_id) throw new Error('request_id required')
    if (value.status !== 'success' && value.status !== 'error') throw new Error('invalid execution status')
    return value as ExecutionResult
  }
  throw new Error(`unsupported connector message: ${value.type}`)
}

