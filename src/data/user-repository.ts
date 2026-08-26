import type { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'

export class UserRepository {
  constructor(private db: Database) {}

  listConversations(userId: string): any[] {
    return this.db.prepare(`SELECT id, name AS title, created_at, created_by, is_default
      FROM group_conversations WHERE user_id=? ORDER BY is_default DESC, created_at DESC`).all(userId) as any[]
  }

  getConversation(userId: string, conversationId: string): any | null {
    return (this.db.prepare(`SELECT id, name AS title, created_at, created_by, is_default
      FROM group_conversations WHERE id=? AND user_id=?`).get(conversationId, userId) as any) || null
  }

  listMessages(userId: string, conversationId: string, limit = 100): any[] {
    return (this.db.prepare(`SELECT id, ts AS created_at, conversation_id, sender_id, sender_model, text,
      images, files, mentions, reply_to, message_type, task_id, meta
      FROM group_messages WHERE user_id=? AND conversation_id=? ORDER BY ts DESC LIMIT ?`)
      .all(userId, conversationId, Math.max(1, Math.min(limit, 500))) as any[]).reverse()
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

