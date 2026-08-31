import type { ExecutionRequest, ExecutionResult, ExecutionTimings } from '../protocol.ts'
import type { CodexExecutionHooks, CodexExecutionMetrics } from '../codex/executor.ts'
import type { ConnectorStateStore } from '../state/store.ts'

export type CodexExecutor = {
  execute(
    request: ExecutionRequest,
    hooks?: CodexExecutionHooks,
  ): Promise<{ content: string; usage: Record<string, number> | null; metrics?: CodexExecutionMetrics }>
  cancel?(requestId: string): Promise<boolean>
}

type ExecutionRecord = {
  request: ExecutionRequest
  receivedAt: string
  acknowledgedAt: string | null
  codexStartedAt: string | null
  promise: Promise<ExecutionResult> | null
  result: ExecutionResult | null
  cancelled: boolean
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
      cancelled: false,
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

  start(request: ExecutionRequest, hooks: Pick<CodexExecutionHooks, 'onDelta'> = {}): Promise<ExecutionResult> {
    if (!this.executions.has(request.request_id)) this.receive(request)
    const record = this.executions.get(request.request_id)!
    if (record.result) return Promise.resolve(record.result)
    if (record.promise) return record.promise

    this.activeCount += 1
    this.state.setExecution('EXECUTION_RUNNING')
    this.log(`[execution] request=${safeId(request.request_id)} state=queued`)
    record.promise = this.executeOnce(record, hooks)
    return record.promise
  }

  // Compatibility helper for non-WebSocket callers and unit tests. Production uses
  // receive -> ACK send -> acknowledge -> start so ACK never waits for model work.
  run(request: ExecutionRequest): Promise<ExecutionResult> {
    this.receive(request)
    this.acknowledge(request.request_id)
    return this.start(request)
  }

  async cancel(requestId: string): Promise<boolean> {
    const record = this.executions.get(requestId)
    if (!record || record.result || record.cancelled) return false
    record.cancelled = true
    this.log(`[execution] request=${safeId(requestId)} state=cancel_requested at=${new Date().toISOString()}`)
    await this.executor.cancel?.(requestId)
    return true
  }

  private async executeOnce(record: ExecutionRecord, hooks: Pick<CodexExecutionHooks, 'onDelta'>): Promise<ExecutionResult> {
    const request = record.request
    let startedMs = Date.now()
    const markStarted = (startedAt: string) => {
      if (record.codexStartedAt) return
      record.codexStartedAt = startedAt
      startedMs = Date.parse(startedAt)
      this.log(`[execution] request=${safeId(request.request_id)} state=codex_running at=${startedAt}`)
    }
    try {
      let sawFirstDelta = false
      const execution = await this.executor.execute(request, {
        onStarted: markStarted,
        onDelta: (delta, createdAt) => {
          if (record.cancelled) return
          if (!sawFirstDelta) {
            sawFirstDelta = true
            this.log(`[stream] request=${safeId(request.request_id)} stage=codex_first_delta at=${createdAt}`)
          }
          hooks.onDelta?.(delta, createdAt)
        },
      })
      if (record.cancelled) throw new Error('CODEX_EXECUTION_CANCELLED')
      if (!record.codexStartedAt) markStarted(new Date(startedMs).toISOString())
      const finishedAt = new Date().toISOString()
      const resultAt = new Date().toISOString()
      const result: ExecutionResult = {
        type: 'execution_result',
        request_id: request.request_id,
        status: 'success',
        content: execution.content,
        usage: execution.usage,
        timings: this.timings(record, finishedAt, resultAt, execution.metrics),
      }
      record.result = result
      this.logCompleted(request.request_id, startedMs, finishedAt, 'success', undefined, execution.metrics)
      this.activeCount -= 1
      if (this.activeCount === 0) this.state.setExecution('EXECUTION_IDLE')
      return result
    } catch (error: any) {
      const rawMessage = error?.message || 'Codex execution failed'
      const errorCode = safeErrorCode(rawMessage)
      const finishedAt = new Date().toISOString()
      const resultAt = new Date().toISOString()
      if (!record.codexStartedAt) markStarted(new Date(startedMs).toISOString())
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

  private timings(record: ExecutionRecord, finishedAt: string, resultAt: string, metrics?: CodexExecutionMetrics): ExecutionTimings {
    const connectorTotalMs = Math.max(0, Date.parse(resultAt) - Date.parse(record.receivedAt))
    return {
      execution_request_at: record.request.created_at,
      execution_received_at: record.receivedAt,
      execution_ack_at: record.acknowledgedAt || record.receivedAt,
      codex_started_at: record.codexStartedAt || record.receivedAt,
      codex_finished_at: finishedAt,
      execution_result_at: resultAt,
      ...(metrics || {}),
      total_ms: connectorTotalMs,
    }
  }

  private logCompleted(
    requestId: string,
    startedMs: number,
    finishedAt: string,
    status: 'success' | 'error',
    error?: string,
    metrics?: CodexExecutionMetrics,
  ): void {
    const duration = Math.max(0, Date.parse(finishedAt) - startedMs)
    const metricLog = metrics
      ? ` queue_wait_ms=${metrics.queue_wait_ms} thread_ms=${metrics.thread_ms} codex_execution_ms=${metrics.codex_execution_ms} total_ms=${metrics.total_ms}`
      : ''
    this.log(`[execution] request=${safeId(requestId)} state=completed at=${finishedAt} duration_ms=${duration}${metricLog} status=${status}${error ? ` error=${error}` : ''}`)
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
  if (/CODEX_EXECUTION_CANCELLED/i.test(message)) return 'CODEX_EXECUTION_CANCELLED'
  if (/CODEX_EXECUTION_TIMEOUT|timed out/i.test(message)) return 'CODEX_EXECUTION_TIMEOUT'
  if (/network|connect|dns|transport/i.test(message)) return 'CODEX_NETWORK_ERROR'
  return 'CODEX_EXECUTION_ERROR'
}
