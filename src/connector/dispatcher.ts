import { randomUUID } from 'crypto'
import type { ExecutionRequest, ExecutionResult } from './protocol.ts'
import { ConnectorRegistry } from './registry.ts'

type Pending = {
  userId: string
  deviceId: string
  resolve: (result: ExecutionResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ConnectorDispatcher {
  private pending = new Map<string, Pending>()

  constructor(private registry: ConnectorRegistry, private defaultTimeoutMs = 120_000) {
    registry.onDisconnect((connection) => this.rejectDevice(connection.deviceId, 'connector disconnected'))
  }

  dispatch(input: Omit<ExecutionRequest, 'type' | 'request_id' | 'created_at'>, timeoutMs = this.defaultTimeoutMs): Promise<ExecutionResult> {
    const connection = this.registry.forUser(input.user_id)
    if (!connection) return Promise.reject(new Error('no online connector for current user'))
    const request: ExecutionRequest = {
      ...input,
      type: 'execution_request',
      request_id: `req_${randomUUID()}`,
      created_at: new Date().toISOString(),
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(request.request_id)) return
        reject(new Error(`connector execution timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(request.request_id, { userId: input.user_id, deviceId: connection.deviceId, resolve, reject, timer })
      try {
        connection.socket.send(JSON.stringify(request))
      } catch (error: any) {
        clearTimeout(timer)
        this.pending.delete(request.request_id)
        reject(new Error(error?.message || 'unable to send connector request'))
      }
    })
  }

  handleResult(deviceId: string, userId: string, result: ExecutionResult): boolean {
    const pending = this.pending.get(result.request_id)
    // Unknown or already-completed request ids are deliberately ignored.
    if (!pending) return false
    // A connector may only answer work dispatched to that exact authenticated device.
    if (pending.deviceId !== deviceId || pending.userId !== userId) return false
    this.pending.delete(result.request_id)
    clearTimeout(pending.timer)
    if (result.status === 'error') pending.reject(new Error(result.error || 'connector execution failed'))
    else pending.resolve(result)
    return true
  }

  rejectDevice(deviceId: string, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.deviceId !== deviceId) continue
      this.pending.delete(requestId)
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
  }

  pendingCount(): number { return this.pending.size }
}

