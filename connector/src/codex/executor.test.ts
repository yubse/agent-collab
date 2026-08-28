import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { AgentEvent, AgentSendOpts } from '../../../src/providers/provider.ts'
import type { ExecutionRequest } from '../protocol.ts'
import { LocalCodexExecutor } from './executor.ts'

type Tracker = { active: number; maxActive: number }

class FakeSharedProvider {
  private selected: string | null = null
  private currentSession: string | null = null
  private event: ((event: AgentEvent) => void) | null = null
  readonly selections: Array<string | null> = []
  readonly options: AgentSendOpts[] = []
  sends = 0
  warmups = 0

  constructor(private delayMs = 0, private tracker: Tracker = { active: 0, maxActive: 0 }) {}

  get sessionId() { return this.currentSession }
  selectThread(threadId: string | null) { this.selected = threadId; this.selections.push(threadId) }
  onEvent(callback: (event: AgentEvent) => void) { this.event = callback }
  onError(_callback: (error: any) => void) {}
  async warmup() { this.warmups += 1 }
  async close() {}
  async interrupt() { return true }
  async send(text: string, opts?: AgentSendOpts) {
    this.sends += 1
    this.options.push(opts || {})
    this.currentSession = this.selected || `thread_${this.sends}`
    this.tracker.active += 1
    this.tracker.maxActive = Math.max(this.tracker.maxActive, this.tracker.active)
    setTimeout(() => {
      this.event?.({ type: 'assistant', text, raw: {} })
      this.event?.({ type: 'result', raw: {} })
      this.tracker.active -= 1
    }, this.delayMs)
  }
}

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })

function request(id: string, conversation: string, agentId = 'product'): ExecutionRequest {
  return {
    type: 'execution_request',
    request_id: id,
    user_id: 'user_tina',
    conversation_id: conversation,
    agent_id: agentId,
    prompt: `prompt ${id}`,
    created_at: new Date().toISOString(),
  }
}

function executor(providers: FakeSharedProvider[]) {
  root = mkdtempSync(path.join(tmpdir(), 'aistudio-codex-pool-'))
  return new LocalCodexExecutor({
    binary: 'codex', cwd: root, stateDir: root, executionTimeoutMs: 1_000,
  }, () => {}, providers as any)
}

describe('LocalCodexExecutor worker pool', () => {
  test('preserves stored threads for non-creative requests', async () => {
    const provider = new FakeSharedProvider()
    const local = executor([provider])

    expect((await local.execute(request('one', 'conversation-a', 'other'))).content).toBe('prompt one')
    expect((await local.execute(request('two', 'conversation-b', 'other'))).content).toBe('prompt two')
    expect((await local.execute(request('three', 'conversation-a', 'other'))).content).toBe('prompt three')
    expect(provider.selections).toEqual([null, null, 'thread_1'])
  })

  test('runs four same-round creative agents concurrently with independent workers', async () => {
    const tracker = { active: 0, maxActive: 0 }
    const providers = [0, 1, 2, 3].map(() => new FakeSharedProvider(60, tracker))
    const local = executor(providers)
    const started = Date.now()
    const results = await Promise.all([
      local.execute(request('creative', 'conversation-a', 'creative')),
      local.execute(request('brand', 'conversation-a', 'brand')),
      local.execute(request('product', 'conversation-a', 'product')),
      local.execute(request('content', 'conversation-a', 'content')),
    ])

    expect(tracker.maxActive).toBe(4)
    expect(Date.now() - started).toBeLessThan(150)
    expect(results.every((result) => result.metrics.queue_wait_ms < 30)).toBe(true)
    expect(providers.every((provider) => provider.selections[0] === null)).toBe(true)
  })

  test('records queue wait and applies role reasoning/tool policy', async () => {
    const tracker = { active: 0, maxActive: 0 }
    const first = new FakeSharedProvider(70, tracker)
    const second = new FakeSharedProvider(70, tracker)
    const local = executor([first, second])
    const [creative, market, director] = await Promise.all([
      local.execute(request('creative', 'conversation-a', 'creative')),
      local.execute(request('market', 'conversation-a', 'market')),
      local.execute(request('director', 'conversation-a', 'director')),
    ])

    expect(Math.max(creative.metrics.queue_wait_ms, market.metrics.queue_wait_ms)).toBeLessThan(30)
    expect(director.metrics.queue_wait_ms).toBeGreaterThanOrEqual(50)
    expect(first.options[0]).toMatchObject({ model: 'gpt-5.6-luna', reasoningEffort: 'low', pureChat: true, freshThread: true })
    expect(second.options[0]).toMatchObject({ model: 'gpt-5.6-terra', reasoningEffort: 'low', pureChat: true, freshThread: true })
    expect(first.options[1]).toMatchObject({ model: 'gpt-5.6-terra', reasoningEffort: 'medium', pureChat: true, freshThread: true })
  })
})
