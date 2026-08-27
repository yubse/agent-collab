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
    expect(logs.join('\n')).toContain('request=req_test')
    expect(logs.join('\n')).toContain('conversation=conv-a')
    expect(logs.join('\n')).toContain('agent=social')
    expect(logs.join('\n')).not.toContain('secret prompt')
    expect(state.snapshot().execution).toBe('EXECUTION_IDLE')
  })
})
