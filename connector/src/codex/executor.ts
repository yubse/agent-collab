import path from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { CodexProvider } from '../../../src/providers/codex.ts'
import type { AgentEvent, AgentSendOpts } from '../../../src/providers/provider.ts'
import type { ExecutionRequest } from '../protocol.ts'
import { creativeAgentSendOptions } from './options.ts'

type DiagnosticLogger = (line: string) => void

type SharedCodexProvider = Pick<CodexProvider,
  'selectThread' | 'sessionId' | 'onEvent' | 'onError' | 'send' | 'warmup' | 'close' | 'interrupt'
>

export type CodexExecutionMetrics = {
  queue_wait_ms: number
  thread_ms: number
  codex_execution_ms: number
  total_ms: number
}

export type CodexExecutionHooks = {
  onStarted?: (startedAt: string) => void
}

type WorkerLease = { index: number; provider: SharedCodexProvider }

/** Fixed app-server pool: one active turn per provider, FIFO when all are busy. */
export class LocalCodexExecutor {
  private readonly providers: SharedCodexProvider[]
  private readonly available: number[]
  private readonly waiters: Array<(lease: WorkerLease) => void> = []
  private sessions = new Map<string, string | null>()

  constructor(
    private config: { binary: string; cwd: string; stateDir: string; executionTimeoutMs: number },
    private log: DiagnosticLogger = (line) => console.error(line),
    providers?: SharedCodexProvider | SharedCodexProvider[],
  ) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
    const supplied = providers ? (Array.isArray(providers) ? providers : [providers]) : []
    this.providers = supplied.length ? supplied : [this.createProvider(0)]
    this.available = this.providers.map((_, index) => index)
  }

  async execute(
    request: ExecutionRequest,
    hooks: CodexExecutionHooks = {},
  ): Promise<{ content: string; usage: any; metrics: CodexExecutionMetrics }> {
    const totalStartedMs = Date.now()
    const lease = await this.acquire()
    const workerStartedMs = Date.now()
    const queueWaitMs = Math.max(0, workerStartedMs - totalStartedMs)
    hooks.onStarted?.(new Date(workerStartedMs).toISOString())
    const key = `${request.user_id}:${request.conversation_id}:${request.agent_id}`
    const opts = creativeAgentSendOptions(request.agent_id)

    try {
      // Creative prompts already contain the exact scoped context for this round.
      // A fresh ephemeral thread avoids silently reloading complete hidden history.
      lease.provider.selectThread(opts.freshThread ? null : this.sessionFor(key))
      const execution = await this.runTurn(lease.provider, request.prompt, opts)
      if (!opts.freshThread) this.persistSession(key, lease.provider.sessionId)
      return {
        content: execution.content,
        usage: execution.usage,
        metrics: {
          queue_wait_ms: queueWaitMs,
          thread_ms: execution.threadMs,
          codex_execution_ms: execution.codexExecutionMs,
          total_ms: Math.max(0, Date.now() - totalStartedMs),
        },
      }
    } finally {
      this.release(lease.index)
    }
  }

  async warmup(): Promise<void> {
    // Managed runtime installation happens on the primary before raw workers start.
    await this.providers[0].warmup()
    await Promise.all(this.providers.slice(1).map((provider) => provider.warmup()))
  }

  async close(): Promise<void> {
    await Promise.all(this.providers.map((provider) => provider.close()))
    this.sessions.clear()
  }

  get workerCount(): number { return this.providers.length }

  private createProvider(index: number): SharedCodexProvider {
    return new CodexProvider({
      label: `connector:app-server-worker-${index + 1}`,
      binaryPath: this.config.binary,
      cwd: this.config.cwd,
      onDiagnostic: (event) => {
        if (event.stream === 'process') {
          this.log(`[codex] worker=${index + 1} status=exited code=${event.exitCode ?? 'unknown'} ${event.message}`)
        } else {
          this.log(`[codex] worker=${index + 1} stream=stderr ${diagnosticSummary(event.message)}`)
        }
      },
    })
  }

  private acquire(): Promise<WorkerLease> {
    const index = this.available.shift()
    if (index !== undefined) return Promise.resolve({ index, provider: this.providers[index] })
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release(index: number): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ index, provider: this.providers[index] })
      return
    }
    this.available.push(index)
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

  private runTurn(
    provider: SharedCodexProvider,
    prompt: string,
    opts: AgentSendOpts,
  ): Promise<{ content: string; usage: any; threadMs: number; codexExecutionMs: number }> {
    return new Promise((resolve, reject) => {
      const assistant: string[] = []
      const threadStartedMs = Date.now()
      let turnAcknowledgedMs: number | null = null
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }
      const timer = setTimeout(() => finish(() => {
        provider.interrupt().catch(() => {})
        reject(new Error('CODEX_EXECUTION_TIMEOUT'))
      }), this.config.executionTimeoutMs)
      provider.onEvent((event: AgentEvent) => {
        if (event.type === 'assistant' && event.text?.trim()) assistant.push(event.text.trim())
        if (event.type === 'result') {
          const finishedMs = Date.now()
          const ackMs = turnAcknowledgedMs ?? threadStartedMs
          finish(() => resolve({
            content: assistant.join('\n\n'),
            usage: event.usage || null,
            threadMs: Math.max(0, ackMs - threadStartedMs),
            codexExecutionMs: Math.max(0, finishedMs - ackMs),
          }))
        }
      })
      provider.onError((error) => finish(() => reject(new Error(error.message))))
      provider.send(prompt, opts)
        .then(() => { turnAcknowledgedMs = Date.now() })
        .catch((error) => finish(() => reject(error)))
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
