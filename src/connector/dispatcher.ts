import { randomUUID } from 'crypto'
import type { CancelRequest, ExecutionAck, ExecutionDelta, ExecutionRequest, ExecutionResult } from './protocol.ts'
import { loadConnectorTimeouts, type ConnectorTimeouts } from './timeouts.ts'
import { ConnectorRegistry } from './registry.ts'

type Pending = {
  userId: string
  deviceId: string
  state: 'sent' | 'running'
  resolve: (result: ExecutionResult) => void
  reject: (error: Error) => void
  ackTimer: ReturnType<typeof setTimeout>
  pendingTimer: ReturnType<typeof setTimeout>
  onDelta?: (delta: ExecutionDelta) => void
  lastDeltaSequence: number
}

type DispatcherTimeouts = Pick<ConnectorTimeouts, 'requestAckTimeoutMs' | 'serverPendingTimeoutMs'>

export class ConnectorDispatcher {
  private pending = new Map<string, Pending>()

  constructor(
    private registry: ConnectorRegistry,
    private timeouts: DispatcherTimeouts = loadConnectorTimeouts(),
    private log: (line: string) => void = console.log,
  ) {
    registry.onDisconnect((connection) => this.rejectDevice(connection.deviceId, 'connector disconnected'))
  }

  dispatch(
    input: Omit<ExecutionRequest, 'type' | 'request_id' | 'created_at'>,
    hooks: { onDelta?: (delta: ExecutionDelta) => void; onRequest?: (requestId: string) => void } = {},
  ): Promise<ExecutionResult> {
    const connection = this.registry.forUser(input.user_id)
    if (!connection) return Promise.reject(new Error('CODEX_CONNECTOR_OFFLINE: no online connector for current user'))
    const request: ExecutionRequest = {
      ...input,
      type: 'execution_request',
      request_id: `req_${randomUUID()}`,
      created_at: new Date().toISOString(),
    }
    return new Promise((resolve, reject) => {
      const ackTimer = setTimeout(() => {
        const pending = this.pending.get(request.request_id)
        if (!pending || pending.state !== 'sent') return
        this.clearPending(request.request_id)
        reject(new Error('CONNECTOR_REQUEST_ACK_TIMEOUT'))
      }, this.timeouts.requestAckTimeoutMs)
      const pendingTimer = setTimeout(() => {
        if (!this.pending.has(request.request_id)) return
        this.clearPending(request.request_id)
        reject(new Error('SERVER_PENDING_TIMEOUT'))
      }, this.timeouts.serverPendingTimeoutMs)
      this.pending.set(request.request_id, {
        userId: input.user_id,
        deviceId: connection.deviceId,
        state: 'sent',
        resolve,
        reject,
        ackTimer,
        pendingTimer,
        onDelta: hooks.onDelta,
        lastDeltaSequence: 0,
      })
      hooks.onRequest?.(request.request_id)
      try {
        connection.socket.send(JSON.stringify(request))
        this.log(`[execution] request=${safeId(request.request_id)} state=request_sent at=${request.created_at}`)
      } catch (error: any) {
        this.clearPending(request.request_id)
        reject(new Error(error?.message || 'unable to send connector request'))
      }
    })
  }

  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    const connection = this.registry.forUser(pending.userId)
    if (connection?.deviceId === pending.deviceId) {
      const request: CancelRequest = { type: 'cancel_request', request_id: requestId, reason: 'user_cancel' }
      try { connection.socket.send(JSON.stringify(request)) } catch {}
    }
    this.clearPending(requestId)
    pending.reject(new Error('CODEX_EXECUTION_CANCELLED'))
    this.log(`[execution] request=${safeId(requestId)} state=cancel_sent at=${new Date().toISOString()}`)
    return true
  }

  handleDelta(deviceId: string, userId: string, delta: ExecutionDelta): boolean {
    const pending = this.pending.get(delta.request_id)
    if (!pending || pending.deviceId !== deviceId || pending.userId !== userId) return false
    if (delta.sequence <= pending.lastDeltaSequence) return false
    pending.lastDeltaSequence = delta.sequence
    pending.onDelta?.(delta)
    return true
  }

  handleAck(deviceId: string, userId: string, ack: ExecutionAck): boolean {
    const pending = this.pending.get(ack.request_id)
    if (!pending) return false
    if (pending.deviceId !== deviceId || pending.userId !== userId) return false
    if (pending.state === 'running') return true
    pending.state = 'running'
    clearTimeout(pending.ackTimer)
    this.log(`[execution] request=${safeId(ack.request_id)} state=ack_received at=${safeTimestamp(ack.acknowledged_at)}`)
    return true
  }

  handleResult(deviceId: string, userId: string, result: ExecutionResult): boolean {
    const pending = this.pending.get(result.request_id)
    // Unknown or already-completed request ids are deliberately ignored. There is no
    // retry or fallback path that can create a second model execution.
    if (!pending) return false
    // A connector may only answer work dispatched to that exact authenticated device.
    if (pending.deviceId !== deviceId || pending.userId !== userId) return false
    this.clearPending(result.request_id)
    const at = result.timings?.execution_result_at || new Date().toISOString()
    this.log(`[execution] request=${safeId(result.request_id)} state=result_received at=${safeTimestamp(at)}`)
    if (result.status === 'error') pending.reject(new Error(result.error || 'connector execution failed'))
    else pending.resolve(result)
    return true
  }

  rejectDevice(deviceId: string, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.deviceId !== deviceId) continue
      this.clearPending(requestId)
      pending.reject(new Error(reason))
    }
  }

  pendingCount(): number { return this.pending.size }
  pendingState(requestId: string): 'sent' | 'running' | null {
    return this.pending.get(requestId)?.state || null
  }

  private clearPending(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.ackTimer)
    clearTimeout(pending.pendingTimer)
  }
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || 'unknown'
}

function safeTimestamp(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : 'invalid'
}
