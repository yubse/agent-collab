import type { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import { canReadChannel } from '../channels/access.ts'

export class UserRepository {
  constructor(private db: Database) {}

  listConversations(userId: string): any[] {
    return this.db.prepare(`SELECT DISTINCT c.id, c.name AS title, c.created_at, c.created_by, c.is_default,
        c.scope, c.owner_user_id
      FROM group_conversations c
      LEFT JOIN channel_memberships m ON m.channel_id=c.id
        AND m.member_type='human' AND m.member_id=? AND m.status='active'
      WHERE m.member_id IS NOT NULL
        OR (c.scope='private' AND COALESCE(c.owner_user_id, c.user_id)=? AND NOT EXISTS (
          SELECT 1 FROM channel_memberships hm
          WHERE hm.channel_id=c.id AND hm.member_type='human' AND hm.status='active'
        ))
      ORDER BY c.is_default DESC, c.created_at DESC`).all(userId, userId) as any[]
  }

  getConversation(userId: string, conversationId: string): any | null {
    if (!canReadChannel(this.db, conversationId, userId)) return null
    return (this.db.prepare(`SELECT id, name AS title, created_at, created_by, is_default, scope, owner_user_id
      FROM group_conversations WHERE id=?`).get(conversationId) as any) || null
  }

  listMessages(userId: string, conversationId: string, limit = 100): any[] {
    const channelExists = this.db.prepare(`SELECT id FROM group_conversations WHERE id=?`).get(conversationId)
    if (channelExists && !canReadChannel(this.db, conversationId, userId)) return []
    const select = `SELECT id, ts AS created_at, conversation_id, sender_id, sender_model,
      sender_actor_type, sender_actor_id, execution_owner_user_id, trigger_message_id, trigger_actor_id,
      thread_id, text, images, files, mentions, reply_to, message_type, task_id, meta FROM group_messages`
    const safeLimit = Math.max(1, Math.min(limit, 500))
    const rows = channelExists
      ? this.db.prepare(`${select} WHERE conversation_id=? AND thread_id IS NULL ORDER BY ts DESC LIMIT ?`).all(conversationId, safeLimit)
      : this.db.prepare(`${select} WHERE user_id=? AND conversation_id=? ORDER BY ts DESC LIMIT ?`).all(userId, conversationId, safeLimit)
    return (rows as any[]).reverse()
  }

  memory(userId: string, agentId: string): any | null {
    return (this.db.prepare(`SELECT id, user_id, agent_id, content, created_at, updated_at
      FROM agent_memories WHERE user_id=? AND agent_id=?`).get(userId, agentId) as any) || null
  }

  saveMemory(userId: string, agentId: string, content: string): any {
    const now = new Date().toISOString()
    const id = `mem_${randomUUID()}`
    this.db.run(`INSERT INTO agent_memories (id, user_id, agent_id, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, agent_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
      [id, userId, agentId, content, now, now])
    return this.memory(userId, agentId)
  }

  task(userId: string, taskId: string): any | null {
    return (this.db.prepare(`SELECT * FROM tasks_v2 WHERE id=? AND user_id=?`).get(taskId, userId) as any) || null
  }

  listTasks(userId: string): any[] {
    return this.db.prepare(`SELECT * FROM tasks_v2 WHERE user_id=? ORDER BY updated_at DESC`).all(userId) as any[]
  }
}
