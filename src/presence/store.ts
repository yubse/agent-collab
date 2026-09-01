export type HumanPresenceStatus = 'online' | 'offline'
export type AgentPresenceStatus = 'idle' | 'queued' | 'working' | 'streaming' | 'error'
export type ConnectorPresenceStatus = 'offline' | 'online' | 'ready'

export type PresenceUpdate = {
  type: 'presence_update'
  actor_type: 'human' | 'agent' | 'connector'
  actor_id: string
  channel_id: string | null
  thread_id: string | null
  status: HumanPresenceStatus | AgentPresenceStatus | ConnectorPresenceStatus
  updated_at: string
  typing?: boolean
  execution_owner_user_id?: string
  request_id?: string
}

type HumanConnection = { userId: string; channelId: string; threadId: string | null; touchedAt: number }
type TypingEntry = { userId: string; channelId: string; threadId: string | null; expiresAt: number }
type AgentExecution = PresenceUpdate & { presenceKey: string; expiresAt?: number }

export class PresenceStore {
  private humans = new Map<string, HumanConnection>()
  private typing = new Map<string, TypingEntry>()
  private agents = new Map<string, AgentExecution>()
  private connectors = new Map<string, PresenceUpdate>()

  constructor(
    private now: () => number = Date.now,
    readonly humanTtlMs = 45_000,
    readonly typingTtlMs = 7_000,
    readonly agentErrorTtlMs = 5_000,
  ) {}

  connectHuman(connectionId: string, userId: string, channelId: string, threadId: string | null): PresenceUpdate {
    this.humans.set(connectionId, { userId, channelId, threadId, touchedAt: this.now() })
    return this.humanUpdate(userId, channelId, threadId, 'online')
  }

  touchHuman(connectionId: string): void {
    const entry = this.humans.get(connectionId)
    if (entry) entry.touchedAt = this.now()
  }

  disconnectHuman(connectionId: string): PresenceUpdate | null {
    const previous = this.humans.get(connectionId)
    if (!previous) return null
    this.humans.delete(connectionId)
    const stillOnline = [...this.humans.values()].some((entry) => entry.userId === previous.userId && entry.channelId === previous.channelId)
    return stillOnline ? null : this.humanUpdate(previous.userId, previous.channelId, previous.threadId, 'offline')
  }

  setTyping(userId: string, channelId: string, threadId: string | null, active: boolean): PresenceUpdate {
    const key = this.typingKey(userId, channelId, threadId)
    if (active) this.typing.set(key, { userId, channelId, threadId, expiresAt: this.now() + this.typingTtlMs })
    else this.typing.delete(key)
    return { ...this.humanUpdate(userId, channelId, threadId, 'online'), typing: active }
  }

  setAgent(input: {
    presenceKey: string; agentId: string; channelId: string; threadId: string | null
    ownerUserId: string; requestId: string; status: AgentPresenceStatus
  }): PresenceUpdate {
    const update: AgentExecution = {
      type: 'presence_update', actor_type: 'agent', actor_id: input.agentId,
      channel_id: input.channelId, thread_id: input.threadId, status: input.status,
      execution_owner_user_id: input.ownerUserId, request_id: input.requestId,
      updated_at: this.iso(), presenceKey: input.presenceKey,
      ...(input.status === 'error' ? { expiresAt: this.now() + this.agentErrorTtlMs } : {}),
    }
    if (input.status === 'idle') this.agents.delete(input.presenceKey)
    else this.agents.set(input.presenceKey, update)
    return update
  }

  setConnector(deviceId: string, userId: string, status: ConnectorPresenceStatus): PresenceUpdate {
    const update: PresenceUpdate = {
      type: 'presence_update', actor_type: 'connector', actor_id: deviceId,
      channel_id: null, thread_id: null, status, updated_at: this.iso(), execution_owner_user_id: userId,
    }
    this.connectors.set(deviceId, update)
    return update
  }

  snapshot(channelId: string, threadId: string | null = null) {
    this.sweep()
    const humans = new Map<string, PresenceUpdate>()
    for (const entry of this.humans.values()) {
      if (entry.channelId !== channelId || this.now() - entry.touchedAt > this.humanTtlMs) continue
      const typing = this.typing.has(this.typingKey(entry.userId, channelId, threadId))
      humans.set(entry.userId, { ...this.humanUpdate(entry.userId, channelId, threadId, 'online'), typing })
    }
    return {
      humans: [...humans.values()],
      agent_executions: [...this.agents.values()].filter((entry) => entry.channel_id === channelId && entry.thread_id === threadId)
        .map(({ presenceKey: _key, expiresAt: _expiry, ...entry }) => entry),
      connectors: [...this.connectors.values()],
    }
  }

  sweep(): PresenceUpdate[] {
    const updates: PresenceUpdate[] = []
    const now = this.now()
    for (const [id, entry] of this.humans) {
      if (now - entry.touchedAt <= this.humanTtlMs) continue
      this.humans.delete(id)
      updates.push(this.humanUpdate(entry.userId, entry.channelId, entry.threadId, 'offline'))
    }
    for (const [key, entry] of this.typing) {
      if (entry.expiresAt > now) continue
      this.typing.delete(key)
      updates.push({ ...this.humanUpdate(entry.userId, entry.channelId, entry.threadId, 'online'), typing: false })
    }
    for (const [key, entry] of this.agents) {
      if (!entry.expiresAt || entry.expiresAt > now) continue
      this.agents.delete(key)
      const { presenceKey: _presenceKey, expiresAt: _expiresAt, ...visible } = entry
      updates.push({ ...visible, status: 'idle', updated_at: this.iso() })
    }
    return updates
  }

  private typingKey(userId: string, channelId: string, threadId: string | null) { return `${userId}:${channelId}:${threadId || ''}` }
  private iso() { return new Date(this.now()).toISOString() }
  private humanUpdate(userId: string, channelId: string, threadId: string | null, status: HumanPresenceStatus): PresenceUpdate {
    return { type: 'presence_update', actor_type: 'human', actor_id: userId, channel_id: channelId, thread_id: threadId, status, updated_at: this.iso() }
  }
}
