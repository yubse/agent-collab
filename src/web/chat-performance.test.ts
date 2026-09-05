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

  test('poll merges server rows without resetting the local history', () => {
    expect(source).toContain('const byId = new Map((cs.messages || []).map(message => [message.id, message]))')
    expect(source).toContain('cs.messages = [...byId.values()]')
    expect(source).not.toContain('cs.cursor = null; pollGroup(channelId)')
    expect(source).not.toContain('scrollMessagesToBottom();\n}')
  })

  test('group and DM availability use the same status projection', () => {
    expect(source).toContain('function agentAvailability(serverId)')
    expect(source).toContain('const availability = agentAvailability(serverId)')
    expect(source).toContain('const availability = agentAvailability(sid)')
  })

  test('profile switching waits for logout and cache-busts the selector', () => {
    expect(source).toContain("stage=logout_start")
    expect(source).toContain("/api/auth/logout")
    expect(source).toContain('/web/login.html?switch=')
  })
})
