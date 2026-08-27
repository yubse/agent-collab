import path from 'path'
import { mkdirSync } from 'fs'
import { CodexProvider } from '../../../src/providers/codex.ts'
import type { AgentEvent } from '../../../src/providers/provider.ts'
import type { ExecutionRequest } from '../protocol.ts'

type Runtime = { provider: CodexProvider; tail: Promise<unknown> }
type DiagnosticLogger = (line: string) => void

export class LocalCodexExecutor {
  private runtimes = new Map<string, Runtime>()

  constructor(
    private config: { binary: string; cwd: string; stateDir: string; executionTimeoutMs: number },
    private log: DiagnosticLogger = (line) => console.error(line),
  ) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
  }

  execute(request: ExecutionRequest): Promise<{ content: string; usage: any }> {
    const key = `${request.conversation_id}:${request.agent_id}`
    let runtime = this.runtimes.get(key)
    if (!runtime) {
      const safe = key.replace(/[^A-Za-z0-9_.-]/g, '_')
      const provider = new CodexProvider({
        label: `connector:${request.agent_id}`,
        binaryPath: this.config.binary,
        cwd: this.config.cwd,
        stateFilePath: path.join(this.config.stateDir, `${safe}.json`),
        onDiagnostic: (event) => {
          if (event.stream === 'process') {
            this.log(`[codex] status=exited code=${event.exitCode ?? 'unknown'} ${event.message}`)
          } else {
            this.log(`[codex] stream=stderr ${diagnosticSummary(event.message)}`)
          }
        },
      })
      runtime = { provider, tail: Promise.resolve() }
      this.runtimes.set(key, runtime)
    }
    const run = runtime.tail.catch(() => {}).then(() => this.runTurn(runtime!.provider, request.prompt))
    runtime.tail = run
    return run
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.provider.close()))
    this.runtimes.clear()
  }

  private runTurn(provider: CodexProvider, prompt: string): Promise<{ content: string; usage: any }> {
    return new Promise((resolve, reject) => {
      const assistant: string[] = []
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }
      const timer = setTimeout(() => finish(() => {
        // A timed-out app-server turn may still be retrying in the background. Kill it
        // before this conversation accepts another request, otherwise replies can cross turns.
        provider.interrupt().catch(() => {})
        reject(new Error('CODEX_EXECUTION_TIMEOUT'))
      }), this.config.executionTimeoutMs)
      provider.onEvent((event: AgentEvent) => {
        if (event.type === 'assistant' && event.text?.trim()) assistant.push(event.text.trim())
        if (event.type === 'result') {
          finish(() => resolve({ content: assistant.join('\n\n'), usage: event.usage || null }))
        }
      })
      provider.onError((error) => finish(() => reject(new Error(error.message))))
      provider.send(prompt).catch((error) => finish(() => reject(error)))
    })
  }
}

function diagnosticSummary(line: string): string {
  if (/request timed out/i.test(line)) return 'code=REQUEST_TIMEOUT'
  if (/falling back to HTTP/i.test(line)) return 'code=FALLBACK_HTTP'
  if (/panic|fatal/i.test(line)) return 'code=CODEX_PROCESS_FATAL'
  try {
    const parsed = JSON.parse(line)
    const level = String(parsed?.level || 'INFO').replace(/[^A-Z]/gi, '').slice(0, 12) || 'INFO'
    const target = String(parsed?.target || 'codex').replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 80) || 'codex'
    return `code=CODEX_DIAGNOSTIC level=${level} target=${target}`
  } catch {
    return 'code=CODEX_DIAGNOSTIC'
  }
}
