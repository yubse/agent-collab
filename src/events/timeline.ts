import type { Database } from 'bun:sqlite'

export type TimelineActorType = 'human' | 'agent' | 'system'
export type TimelineEvent = {
  id?: string; channelId: string; threadId?: string | null; eventType: string
  actorType: TimelineActorType; actorId: string; targetType?: string | null; targetId?: string | null
  correlationId?: string | null; metadata?: Record<string, unknown>; createdAt?: string
}

const EVENT_TYPES = new Set([
  'message.created','thread.created','member.joined','member.removed','member.role_changed',
  'agent.queued','agent.started','agent.completed','agent.failed','agent.cancelled',
  'discussion.started','discussion.completed','task.created','task.updated','task.completed',
  'meeting_minutes.created','meeting_minutes.completed','meeting_minutes.failed',
])

export function appendTimelineEvent(db: Database, event: TimelineEvent): boolean {
  if (!EVENT_TYPES.has(event.eventType)) return false
  // DMs and other legacy runtime conversations are not Channels; Timeline is
  // intentionally scoped to persisted Channel rows only.
  if (!db.prepare(`SELECT 1 FROM group_conversations WHERE id=?`).get(event.channelId)) return false
  const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {}
  const result = db.prepare(`INSERT OR IGNORE INTO events
    (id, channel_id, thread_id, event_type, actor_type, actor_id, target_type, target_id,
     correlation_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.id || crypto.randomUUID(), event.channelId, event.threadId || null, event.eventType,
      event.actorType, event.actorId, event.targetType || null, event.targetId || null,
      event.correlationId || null, JSON.stringify(metadata), event.createdAt || new Date().toISOString())
  return Number(result.changes || 0) > 0
}

export function parseTimelineMetadata(row: any) {
  let metadata: Record<string, unknown> = {}
  try { metadata = JSON.parse(row.metadata_json || '{}') } catch {}
  const { metadata_json: _ignored, ...rest } = row
  return { ...rest, metadata }
}
