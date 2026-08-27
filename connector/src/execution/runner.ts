import type { ExecutionRequest, ExecutionResult } from '../protocol.ts'
import type { ConnectorStateStore } from '../state/store.ts'

export type CodexExecutor = {
  execute(request: ExecutionRequest): Promise<{ content: string; usage: Record<string, number> | null }>
}

export class ExecutionRunner {
  constructor(
    private executor: CodexExecutor,
    private state: ConnectorStateStore,
    private log: (line: string) => void = console.log,
  ) {}

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const prefix = `[execution] request=${request.request_id} conversation=${request.conversation_id} agent=${request.agent_id}`
    this.state.setExecution('EXECUTION_RUNNING')
    this.log(`${prefix} status=started`)
    try {
      const result = await this.executor.execute(request)
      this.state.setExecution('EXECUTION_IDLE')
      this.log(`${prefix} status=success`)
      return {
        type: 'execution_result',
        request_id: request.request_id,
        status: 'success',
        content: result.content,
        usage: result.usage,
      }
    } catch (error: any) {
      const message = error?.message || 'Codex execution failed'
      this.state.setExecution('EXECUTION_ERROR', message)
      this.log(`${prefix} status=error error=${safeErrorCode(message)}`)
      return { type: 'execution_result', request_id: request.request_id, status: 'error', error: message }
    }
  }
}

function safeErrorCode(message: string): string {
  if (/timed out/i.test(message)) return 'CODEX_EXECUTION_TIMEOUT'
  if (/network|connect|dns|transport/i.test(message)) return 'CODEX_NETWORK_ERROR'
  return 'CODEX_EXECUTION_ERROR'
}
