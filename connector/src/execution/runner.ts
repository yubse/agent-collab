import type { ExecutionRequest, ExecutionResult, ExecutionTimings } from '../protocol.ts'
import type { ConnectorStateStore } from '../state/store.ts'

export type CodexExecutor = {
  execute(request: ExecutionRequest): Promise<{ content: string; usage: Record<string, number> | null }>
}

type ExecutionRecord = {
  request: ExecutionRequest
  receivedAt: string
  acknowledgedAt: string | null
  codexStartedAt: string | null
  promise: Promise<ExecutionResult> | null
  result: ExecutionResult | null
}

export class ExecutionRunner {
  private executions = new Map<string, ExecutionRecord>()
  private activeCount = 0

  constructor(
    private executor: CodexExecutor,
    private state: ConnectorStateStore,
    private log: (line: string) => void = console.log,
  ) {}

  receive(request: ExecutionRequest): { isNew: boolean } {
    if (this.executions.has(request.request_id)) return { isNew: false }
    this.trimCompleted()
    const receivedAt = new Date().toISOString()
    this.executions.set(request.request_id, {
      request,
      receivedAt,
      acknowledgedAt: null,
      codexStartedAt: null,
      promise: null,
      result: null,
    })
    this.log(`[execution] request=${safeId(request.request_id)} state=received at=${receivedAt}`)
    return { isNew: true }
  }

  acknowledge(requestId: string, acknowledgedAt = new Date().toISOString()): void {
    const record = this.executions.get(requestId)
    if (!record || record.acknowledgedAt) return
    record.acknowledgedAt = acknowledgedAt
    this.log(`[execution] request=${safeId(requestId)} state=acknowledged at=${acknowledgedAt}`)
  }

  start(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!this.executions.has(request.request_id)) this.receive(request)
    const record = this.executions.get(request.request_id)!
    if (record.result) return Promise.resolve(record.result)
    if (record.promise) return record.promise

    record.codexStartedAt = new Date().toISOString()
    this.activeCount += 1
    this.state.setExecution('EXECUTION_RUNNING')
    this.log(`[execution] request=${safeId(request.request_id)} state=codex_running at=${record.codexStartedAt}`)
    record.promise = this.executeOnce(record)
    return record.promise
  }

  // Compatibility helper for non-WebSocket callers and unit tests. Production uses
  // receive -> ACK send -> acknowledge -> start so ACK never waits for model work.
  run(request: ExecutionRequest): Promise<ExecutionResult> {
    this.receive(request)
    this.acknowledge(request.request_id)
    return this.start(request)
  }

  private async executeOnce(record: ExecutionRecord): Promise<ExecutionResult> {
    const request = record.request
    const startedMs = Date.parse(record.codexStartedAt!)
    try {
      const execution = await this.executor.execute(request)
      const finishedAt = new Date().toISOString()
      const resultAt = new Date().toISOString()
      const result: ExecutionResult = {
        type: 'execution_result',
        request_id: request.request_id,
        status: 'success',
        content: execution.content,
        usage: execution.usage,
        timings: this.timings(record, finishedAt, resultAt),
      }
      record.result = result
      this.logCompleted(request.request_id, startedMs, finishedAt, 'success')
      this.activeCount -= 1
      if (this.activeCount === 0) this.state.setExecution('EXECUTION_IDLE')
      return result
    } catch (error: any) {
      const rawMessage = error?.message || 'Codex execution failed'
      const errorCode = safeErrorCode(rawMessage)
      const finishedAt = new Date().toISOString()
      const resultAt = new Date().toISOString()
      const result: ExecutionResult = {
        type: 'execution_result',
        request_id: request.request_id,
        status: 'error',
        error: errorCode,
        timings: this.timings(record, finishedAt, resultAt),
      }
      record.result = result
      this.logCompleted(request.request_id, startedMs, finishedAt, 'error', errorCode)
      this.activeCount -= 1
      if (this.activeCount === 0) this.state.setExecution('EXECUTION_ERROR', errorCode)
      return result
    }
  }

  private timings(record: ExecutionRecord, finishedAt: string, resultAt: string): ExecutionTimings {
    return {
      execution_request_at: record.request.created_at,
      execution_received_at: record.receivedAt,
      execution_ack_at: record.acknowledgedAt || record.receivedAt,
      codex_started_at: record.codexStartedAt || record.receivedAt,
      codex_finished_at: finishedAt,
      execution_result_at: resultAt,
    }
  }

  private logCompleted(requestId: string, startedMs: number, finishedAt: string, status: 'success' | 'error', error?: string): void {
    const duration = Math.max(0, Date.parse(finishedAt) - startedMs)
    this.log(`[execution] request=${safeId(requestId)} state=completed at=${finishedAt} duration_ms=${duration} status=${status}${error ? ` error=${error}` : ''}`)
  }

  private trimCompleted(): void {
    if (this.executions.size < 1_000) return
    for (const [requestId, record] of this.executions) {
      if (!record.result) continue
      this.executions.delete(requestId)
      if (this.executions.size < 1_000) break
    }
  }
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || 'unknown'
}

function safeErrorCode(message: string): string {
  if (/CODEX_EXECUTION_TIMEOUT|timed out/i.test(message)) return 'CODEX_EXECUTION_TIMEOUT'
  if (/network|connect|dns|transport/i.test(message)) return 'CODEX_NETWORK_ERROR'
  return 'CODEX_EXECUTION_ERROR'
}
