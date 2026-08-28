import { describe, expect, test } from 'bun:test'
import { ConnectorStateStore } from './store.ts'

describe('ConnectorStateStore', () => {
  test('tracks reusable server, Codex and execution states', () => {
    const store = new ConnectorStateStore()
    store.setServer('SERVER_CONNECTED')
    store.setCodex('CODEX_READY')
    store.setExecution('EXECUTION_RUNNING')
    expect(store.snapshot()).toMatchObject({
      server: 'SERVER_CONNECTED',
      codex: 'CODEX_READY',
      execution: 'EXECUTION_RUNNING',
      lastError: null,
    })
    store.setExecution('EXECUTION_ERROR', 'network unavailable')
    expect(store.snapshot().lastError).toBe('network unavailable')
    store.setServer('SERVER_DISCONNECTED', 'connector authentication failed')
    store.setCodex('CODEX_READY')
    expect(store.snapshot().serverError).toBe('connector authentication failed')
  })
})
