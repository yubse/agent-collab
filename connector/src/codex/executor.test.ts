import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { AgentEvent } from '../../../src/providers/provider.ts'
import type { ExecutionRequest } from '../protocol.ts'
import { LocalCodexExecutor } from './executor.ts'

class FakeSharedProvider {
  private selected: string | null = null
  private currentSession: string | null = null
  private event: ((event: AgentEvent) => void) | null = null
  private error: ((error: any) => void) | null = null
  readonly selections: Array<string | null> = []
  sends = 0
  warmups = 0

  get sessionId() { return this.currentSession }
  selectThread(threadId: string | null) { this.selected = threadId; this.selections.push(threadId) }
  onEvent(callback: (event: AgentEvent) => void) { this.event = callback }
  onError(callback: (error: any) => void) { this.error = callback }
  async warmup() { this.warmups += 1 }
  async close() {}
  async interrupt() { return true }
  async send(text: string) {
    this.sends += 1
    this.currentSession = this.selected || `thread_${this.sends}`
    queueMicrotask(() => {
      this.event?.({ type: 'assistant', text, raw: {} })
      this.event?.({ type: 'result', raw: {} })
    })
  }
}

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })

function request(id: string, conversation: string): ExecutionRequest {
  return {
    type: 'execution_request',
    request_id: id,
    user_id: 'user_tina',
    conversation_id: conversation,
    agent_id: 'product',
    prompt: `prompt ${id}`,
    created_at: new Date().toISOString(),
  }
}

describe('LocalCodexExecutor shared app-server', () => {
  test('reuses one provider while preserving per-conversation threads', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'aistudio-shared-codex-'))
    const provider = new FakeSharedProvider()
    const executor = new LocalCodexExecutor({
      binary: 'codex', cwd: root, stateDir: root, executionTimeoutMs: 1_000,
    }, () => {}, provider as any)

    expect((await executor.execute(request('one', 'conversation-a'))).content).toBe('prompt one')
    expect((await executor.execute(request('two', 'conversation-b'))).content).toBe('prompt two')
    expect((await executor.execute(request('three', 'conversation-a'))).content).toBe('prompt three')
    expect(provider.sends).toBe(3)
    expect(provider.selections).toEqual([null, null, 'thread_1'])
  })
})
