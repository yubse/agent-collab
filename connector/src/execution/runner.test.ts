import { describe, expect, test } from 'bun:test'
import { ExecutionRunner } from './runner.ts'
import { ConnectorStateStore } from '../state/store.ts'
import type { ExecutionRequest } from '../protocol.ts'

const request: ExecutionRequest = {
  type: 'execution_request', request_id: 'req_test', user_id: 'user-a',
  conversation_id: 'conv-a', agent_id: 'social', prompt: 'secret prompt', created_at: new Date().toISOString(),
}

describe('ExecutionRunner', () => {
  test('logs identifiers and status without logging the prompt', async () => {
    const logs: string[] = []
    const state = new ConnectorStateStore()
    const runner = new ExecutionRunner({ execute: async () => ({ content: 'CONNECTOR_OK', usage: null }) }, state, (line) => logs.push(line))
    const result = await runner.run(request)
    expect(result).toMatchObject({ status: 'success', content: 'CONNECTOR_OK' })
    expect(logs.join('\n')).toContain('state=received')
    expect(logs.join('\n')).toContain('state=acknowledged')
    expect(logs.join('\n')).toContain('state=codex_running')
    expect(logs.join('\n')).toContain('state=completed')
    expect(logs.join('\n')).not.toContain('secret prompt')
    expect(state.snapshot().execution).toBe('EXECUTION_IDLE')
  })

  test('forwards four execution metrics without exposing content in logs', async () => {
    const logs: string[] = []
    const runner = new ExecutionRunner({
      execute: async (_request, hooks) => {
        hooks?.onStarted?.(new Date().toISOString())
        return {
          content: 'private response', usage: null,
          metrics: { queue_wait_ms: 4, thread_ms: 8, codex_execution_ms: 12, total_ms: 24 },
        }
      },
    }, new ConnectorStateStore(), (line) => logs.push(line))
    const result = await runner.run({ ...request, request_id: 'req_metrics' })
    expect(result.timings).toMatchObject({ queue_wait_ms: 4, thread_ms: 8, codex_execution_ms: 12 })
    expect(typeof result.timings?.total_ms).toBe('number')
    expect(logs.join('\n')).toContain('queue_wait_ms=4 thread_ms=8 codex_execution_ms=12')
    expect(logs.join('\n')).not.toContain('private response')
  })

  test('executes the same request_id only once', async () => {
    let calls = 0
    const state = new ConnectorStateStore()
    const runner = new ExecutionRunner({
      execute: async () => {
        calls += 1
        await Bun.sleep(10)
        return { content: 'CONNECTOR_OK', usage: null }
      },
    }, state, () => {})
    runner.receive(request)
    runner.acknowledge(request.request_id)
    const [first, duplicate] = await Promise.all([runner.start(request), runner.start(request)])
    expect(calls).toBe(1)
    expect(first).toEqual(duplicate)
  })

  test('returns the explicit timeout code', async () => {
    const state = new ConnectorStateStore()
    const runner = new ExecutionRunner({
      execute: async () => { throw new Error('CODEX_EXECUTION_TIMEOUT') },
    }, state, () => {})
    const timedRequest = { ...request, request_id: 'req_timeout' }
    const result = await runner.run(timedRequest)
    expect(result).toMatchObject({ status: 'error', error: 'CODEX_EXECUTION_TIMEOUT' })
  })

  test('cancels only the requested execution and drops later deltas', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cancelled: string[] = []
    const deltas: string[] = []
    const runner = new ExecutionRunner({
      execute: async (_input, hooks) => {
        hooks?.onDelta?.('before', new Date().toISOString())
        await gate
        hooks?.onDelta?.('late', new Date().toISOString())
        return { content: 'late result', usage: null }
      },
      cancel: async (requestId) => { cancelled.push(requestId); return true },
    }, new ConnectorStateStore(), () => {})
    const current = { ...request, request_id: 'req_cancel_exact' }
    runner.receive(current)
    runner.acknowledge(current.request_id)
    const resultPromise = runner.start(current, { onDelta: (delta) => deltas.push(delta) })
    await Bun.sleep(0)
    expect(await runner.cancel(current.request_id)).toBe(true)
    release()

    expect(await resultPromise).toMatchObject({ status: 'error', error: 'CODEX_EXECUTION_CANCELLED' })
    expect(cancelled).toEqual(['req_cancel_exact'])
    expect(deltas).toEqual(['before'])
  })
})
