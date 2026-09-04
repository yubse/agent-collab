import type { Database } from 'bun:sqlite'
import { CREATIVE_AGENT_BY_ID, type CreativeAgentId } from '../creative-discussion.ts'
import { MEETING_MINUTES_AGENT, MEETING_MINUTES_AGENT_ID } from '../meeting-minutes.ts'

export type ActorType = 'human' | 'agent' | 'system'

export type ResolvedActor = {
  type: ActorType
  id: string
  display_name: string
}

export function resolveActor(db: Database, type: ActorType, id: string): ResolvedActor | null {
  if (type === 'system') return id === 'system' ? { type, id: 'system', display_name: 'System' } : null
  if (type === 'human') {
    const user = db.prepare(`SELECT id, display_name FROM users WHERE id=?`).get(id) as any
    return user ? { type, id: String(user.id), display_name: String(user.display_name) } : null
  }
  const agent = CREATIVE_AGENT_BY_ID.get(id as CreativeAgentId)
  if (agent) return { type, id: agent.id, display_name: agent.displayName }
  return id === MEETING_MINUTES_AGENT_ID
    ? { type, id: MEETING_MINUTES_AGENT_ID, display_name: MEETING_MINUTES_AGENT.displayName }
    : null
}

export function actorForNewMessage(senderId: string, authenticatedUserId: string): Pick<ResolvedActor, 'type' | 'id'> | null {
  if (senderId === 'system') return { type: 'system', id: 'system' }
  if (senderId === 'admin') return { type: 'human', id: authenticatedUserId }
  if (CREATIVE_AGENT_BY_ID.has(senderId as CreativeAgentId) || senderId === MEETING_MINUTES_AGENT_ID) return { type: 'agent', id: senderId }
  return null
}

export function resolvedActorForMessage(db: Database, message: {
  sender_actor_type?: ActorType | null
  sender_actor_id?: string | null
  sender_id: string
  user_id: string
}): ResolvedActor | null {
  if (message.sender_actor_type && message.sender_actor_id) {
    return resolveActor(db, message.sender_actor_type, message.sender_actor_id)
  }
  const fallback = actorForNewMessage(message.sender_id, message.user_id)
  return fallback ? resolveActor(db, fallback.type, fallback.id) : null
}
