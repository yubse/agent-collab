import { describe, expect, test } from 'bun:test'
import { PresenceStore } from './store.ts'

describe('PresenceStore', () => {
  test('human connection, typing TTL and disconnect are scoped', () => {
    let now = 1_000
    const store = new PresenceStore(() => now, 10_000, 5_000)
    store.connectHuman('a', 'tina', 'channel-a', null)
    store.connectHuman('b', 'liu', 'channel-a', 'thread-1')
    store.setTyping('tina', 'channel-a', null, true)
    expect(store.snapshot('channel-a').humans.find(x => x.actor_id === 'tina')?.typing).toBe(true)
    expect(store.snapshot('channel-a', 'thread-1').humans.find(x => x.actor_id === 'tina')?.typing).toBe(false)
    expect(store.snapshot('channel-b').humans).toHaveLength(0)
    now += 5_001
    expect(store.sweep().some(x => x.actor_id === 'tina' && x.typing === false)).toBe(true)
    expect(store.disconnectHuman('a')?.status).toBe('offline')
  })

  test('same agent executions remain independent across owner, channel and thread', () => {
    const store = new PresenceStore()
    store.setAgent({ presenceKey: 'r1', agentId: 'agent-a', channelId: 'a', threadId: null, ownerUserId: 'tina', requestId: 'r1', status: 'working' })
    store.setAgent({ presenceKey: 'r2', agentId: 'agent-a', channelId: 'b', threadId: 't1', ownerUserId: 'liu', requestId: 'r2', status: 'streaming' })
    expect(store.snapshot('a').agent_executions).toHaveLength(1)
    expect(store.snapshot('b', 't1').agent_executions[0].execution_owner_user_id).toBe('liu')
    store.setAgent({ presenceKey: 'r1', agentId: 'agent-a', channelId: 'a', threadId: null, ownerUserId: 'tina', requestId: 'r1', status: 'idle' })
    expect(store.snapshot('a').agent_executions).toHaveLength(0)
    expect(store.snapshot('b', 't1').agent_executions).toHaveLength(1)
  })

  test('connector distinguishes online and ready without persisting state', () => {
    const store = new PresenceStore()
    store.setConnector('mac', 'tina', 'online')
    expect(store.snapshot('a').connectors[0].status).toBe('online')
    store.setConnector('mac', 'tina', 'ready')
    expect(store.snapshot('a').connectors[0].status).toBe('ready')
  })

  test('one browser disconnect does not mark a user offline while another tab remains', () => {
    const store = new PresenceStore()
    store.connectHuman('tab-1', 'tina', 'channel-a', null)
    store.connectHuman('tab-2', 'tina', 'channel-a', null)
    expect(store.disconnectHuman('tab-1')).toBeNull()
    expect(store.snapshot('channel-a').humans[0].status).toBe('online')
    expect(store.disconnectHuman('tab-2')?.status).toBe('offline')
  })

  test('agent error expires to idle and a fresh server store restores no transient presence', () => {
    let now = 1_000
    const store = new PresenceStore(() => now, 10_000, 5_000, 2_000)
    store.setAgent({ presenceKey: 'r1', agentId: 'agent-a', channelId: 'a', threadId: null, ownerUserId: 'tina', requestId: 'r1', status: 'error' })
    expect(store.snapshot('a').agent_executions[0].status).toBe('error')
    now += 2_001
    expect(store.sweep()[0].status).toBe('idle')
    expect(new PresenceStore().snapshot('a').agent_executions).toHaveLength(0)
  })
})
