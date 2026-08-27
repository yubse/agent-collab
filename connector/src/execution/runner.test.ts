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
})
