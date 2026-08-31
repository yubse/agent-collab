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

export type ExecutionAck = {
  type: 'execution_ack'
  request_id: string
  status: 'running'
  acknowledged_at: string
}

export type ExecutionDelta = {
  type: 'execution_delta'
  request_id: string
  sequence: number
  delta: string
  created_at: string
}

export type CancelRequest = {
  type: 'cancel_request'
  request_id: string
  reason: 'user_cancel'
}

export type ExecutionTimings = {
  execution_request_at: string
  execution_received_at: string
  execution_ack_at: string
  codex_started_at: string
  codex_finished_at: string
  execution_result_at: string
  queue_wait_ms?: number
  thread_ms?: number
  codex_execution_ms?: number
  total_ms?: number
}

export type ExecutionResult = {
  type: 'execution_result'
  request_id: string
  status: 'success' | 'error'
  content?: string
  usage?: Record<string, number> | null
  error?: string
  timings?: ExecutionTimings
}

export type ConnectorToServer = ConnectorHello | ConnectorHeartbeat | ExecutionAck | ExecutionDelta | ExecutionResult
export type ServerToConnector = ConnectorHelloAck | ConnectorHeartbeatAck | ExecutionRequest | CancelRequest

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
  if (value.type === 'execution_ack') {
    if (typeof value.request_id !== 'string' || !value.request_id) throw new Error('request_id required')
    if (value.status !== 'running') throw new Error('invalid execution ack status')
    if (typeof value.acknowledged_at !== 'string' || !value.acknowledged_at) throw new Error('acknowledged_at required')
    return value as ExecutionAck
  }
  if (value.type === 'execution_delta') {
    if (typeof value.request_id !== 'string' || !value.request_id) throw new Error('request_id required')
    if (!Number.isInteger(value.sequence) || value.sequence < 1) throw new Error('invalid delta sequence')
    if (typeof value.delta !== 'string' || !value.delta) throw new Error('delta required')
    return value as ExecutionDelta
  }
  if (value.type === 'execution_result') {
    if (typeof value.request_id !== 'string' || !value.request_id) throw new Error('request_id required')
    if (value.status !== 'success' && value.status !== 'error') throw new Error('invalid execution status')
    return value as ExecutionResult
  }
  throw new Error(`unsupported connector message: ${value.type}`)
}
