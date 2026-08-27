import path from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { CodexProvider } from '../../../src/providers/codex.ts'
import type { AgentEvent } from '../../../src/providers/provider.ts'
import type { ExecutionRequest } from '../protocol.ts'

type DiagnosticLogger = (line: string) => void

type SharedCodexProvider = Pick<CodexProvider,
  'selectThread' | 'sessionId' | 'onEvent' | 'onError' | 'send' | 'warmup' | 'close' | 'interrupt'
>

export class LocalCodexExecutor {
  private readonly provider: SharedCodexProvider
  private tail: Promise<unknown> = Promise.resolve()
  private sessions = new Map<string, string | null>()

  constructor(
    private config: { binary: string; cwd: string; stateDir: string; executionTimeoutMs: number },
    private log: DiagnosticLogger = (line) => console.error(line),
    provider?: SharedCodexProvider,
  ) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
    this.provider = provider || new CodexProvider({
      label: 'connector:shared-app-server',
      binaryPath: this.config.binary,
      cwd: this.config.cwd,
      onDiagnostic: (event) => {
        if (event.stream === 'process') {
          this.log(`[codex] status=exited code=${event.exitCode ?? 'unknown'} ${event.message}`)
        } else {
          this.log(`[codex] stream=stderr ${diagnosticSummary(event.message)}`)
        }
      },
    })
  }

  execute(request: ExecutionRequest): Promise<{ content: string; usage: any }> {
    const key = `${request.user_id}:${request.conversation_id}:${request.agent_id}`
    const run = this.tail.catch(() => {}).then(async () => {
      this.provider.selectThread(this.sessionFor(key))
      const result = await this.runTurn(this.provider, request.prompt)
      this.persistSession(key, this.provider.sessionId)
      return result
    })
    this.tail = run
    return run
  }

  warmup(): Promise<void> {
    return this.provider.warmup()
  }

  async close(): Promise<void> {
    await this.provider.close()
    this.sessions.clear()
  }

  private sessionFor(key: string): string | null {
    if (this.sessions.has(key)) return this.sessions.get(key) || null
    const statePath = this.statePath(key)
    let sessionId: string | null = null
    try {
      if (existsSync(statePath)) sessionId = JSON.parse(readFileSync(statePath, 'utf8'))?.session_id || null
    } catch {}
    this.sessions.set(key, sessionId)
    return sessionId
  }

  private persistSession(key: string, sessionId: string | null): void {
    this.sessions.set(key, sessionId)
    writeFileSync(this.statePath(key), JSON.stringify({ session_id: sessionId, updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 })
  }

  private statePath(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9_.-]/g, '_')
    return path.join(this.config.stateDir, `${safe}.json`)
  }

  private runTurn(provider: SharedCodexProvider, prompt: string): Promise<{ content: string; usage: any }> {
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
