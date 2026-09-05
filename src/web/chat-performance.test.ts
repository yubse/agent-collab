import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../web/workgroup-v2/index.html', import.meta.url), 'utf8')

describe('chat performance safeguards', () => {
  test('inserts and merges optimistic human messages', () => {
    expect(source).toContain('_insertPendingHumanMessage')
    expect(source).toContain('_mergeSentHumanMessage')
    expect(source).toContain('_markPendingHumanMessageFailed')
    expect(source).toContain('发送中…')
  })

  test('does not send a second browser request for a replayed stream event', () => {
    expect(source).toContain("_consumeExecutionEvents([payload], 'sse')")
    expect(source).toContain("], 'poll')")
    expect(source).toContain('source=${source}')
    expect(source).toContain('message_id=${messageId}')
  })
})
