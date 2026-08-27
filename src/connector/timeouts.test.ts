import { describe, expect, test } from 'bun:test'
import { CONNECTOR_TIMEOUT_DEFAULTS, loadConnectorTimeouts } from './timeouts.ts'

describe('connector timeout configuration', () => {
  test('uses independent defaults', () => {
    expect(loadConnectorTimeouts({})).toEqual(CONNECTOR_TIMEOUT_DEFAULTS)
  })

  test('allows each timeout to be overridden independently', () => {
    expect(loadConnectorTimeouts({
      CONNECT_TIMEOUT_MS: '1',
      REQUEST_ACK_TIMEOUT_MS: '2',
      EXECUTION_TIMEOUT_MS: '3',
      SERVER_PENDING_TIMEOUT_MS: '4',
    })).toEqual({
      connectTimeoutMs: 1,
      requestAckTimeoutMs: 2,
      executionTimeoutMs: 3,
      serverPendingTimeoutMs: 4,
    })
  })
})
