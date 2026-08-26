import path from 'path'
import { mkdirSync } from 'fs'
import { CodexProvider } from '../../src/providers/codex.ts'
import type { AgentEvent } from '../../src/providers/provider.ts'
import type { ExecutionRequest } from './protocol.ts'

type Runtime = { provider: CodexProvider; tail: Promise<unknown> }

export class LocalCodexExecutor {
  private runtimes = new Map<string, Runtime>()

  constructor(private config: { binary: string; cwd: string; stateDir: string }) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
  }

  static verify(binary: string): void {
    const result = Bun.spawnSync([binary, 'login', 'status'], { stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error('Codex CLI is not logged in. Run `codex login` on this computer first.')
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
      })
      runtime = { provider, tail: Promise.resolve() }
      this.runtimes.set(key, runtime)
    }
    const run = runtime.tail.catch(() => {}).then(() => this.runTurn(runtime!.provider, request.prompt))
    runtime.tail = run
    return run
  }

  private runTurn(provider: CodexProvider, prompt: string): Promise<{ content: string; usage: any }> {
    return new Promise((resolve, reject) => {
      const assistant: string[] = []
      const timer = setTimeout(() => reject(new Error('local Codex execution timed out')), 115_000)
      provider.onEvent((event: AgentEvent) => {
        if (event.type === 'assistant' && event.text?.trim()) assistant.push(event.text.trim())
        if (event.type === 'result') {
          clearTimeout(timer)
          resolve({ content: assistant.join('\n\n'), usage: event.usage || null })
        }
      })
      provider.onError((error) => {
        clearTimeout(timer)
        reject(new Error(error.message))
      })
      provider.send(prompt).catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }
}

