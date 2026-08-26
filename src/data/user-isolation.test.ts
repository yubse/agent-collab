import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { runMigrations } from '../db/migrations.ts'
import { createSession, createUser, authenticatedUser } from '../auth/user-auth.ts'
import { UserRepository } from './user-repository.ts'

let db: Database
let repo: UserRepository

function createLegacyTables(database: Database) {
  database.run(`CREATE TABLE group_conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0)`)
  database.run(`CREATE TABLE group_messages (id TEXT PRIMARY KEY, ts TEXT NOT NULL, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_model TEXT, text TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]', mentions TEXT NOT NULL DEFAULT '[]', reply_to TEXT, message_type TEXT NOT NULL DEFAULT 'chat', task_id TEXT, meta TEXT NOT NULL DEFAULT '{}')`)
  database.run(`CREATE TABLE group_tasks (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL)`)
  database.run(`CREATE TABLE tasks_v2 (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', current_phase TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, created_by TEXT NOT NULL, closed_at TEXT, closed_by TEXT, updated_at TEXT NOT NULL)`)
  database.run(`CREATE TABLE actor_channel_seen (actor_id TEXT NOT NULL, channel TEXT NOT NULL, last_seen_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(actor_id, channel))`)
}

beforeEach(() => {
  db = new Database(':memory:')
  db.run('PRAGMA foreign_keys=ON')
  createLegacyTables(db)
  runMigrations(db)
  repo = new UserRepository(db)
})

async function users() {
  const a = await createUser(db, { username: 'user_a', displayName: 'User A', password: 'correct-horse-a' })
  const b = await createUser(db, { username: 'user_b', displayName: 'User B', password: 'correct-horse-b' })
  return { a, b }
}

describe('user ownership isolation', () => {
  test('test_user_cannot_read_other_conversation', async () => {
    const { a, b } = await users()
    db.run(`INSERT INTO group_conversations (id,name,created_at,created_by,is_default,user_id) VALUES ('conv-a','A','2026-01-01','admin',0,?)`, [a.id])
    expect(repo.getConversation(a.id, 'conv-a')?.id).toBe('conv-a')
    expect(repo.getConversation(b.id, 'conv-a')).toBeNull()
  })

  test('test_user_cannot_read_other_messages', async () => {
    const { a, b } = await users()
    db.run(`INSERT INTO group_messages (id,ts,conversation_id,sender_id,text,user_id) VALUES ('msg-a','2026-01-01','conv-a','admin','secret',?)`, [a.id])
    expect(repo.listMessages(a.id, 'conv-a')).toHaveLength(1)
    expect(repo.listMessages(b.id, 'conv-a')).toHaveLength(0)
  })

  test('test_user_memory_isolation', async () => {
    const { a, b } = await users()
    repo.saveMemory(a.id, 'social', 'A private memory')
    repo.saveMemory(b.id, 'social', 'B private memory')
    expect(repo.memory(a.id, 'social')?.content).toBe('A private memory')
    expect(repo.memory(b.id, 'social')?.content).toBe('B private memory')
  })

  test('session identity comes from server record, not request user_id', async () => {
    const { a, b } = await users()
    const { token } = createSession(db, a.id)
    const req = new Request('http://localhost/api/me?user_id=' + b.id, { headers: { cookie: `aicollab_session=${token}` } })
    expect(authenticatedUser(db, req)?.id).toBe(a.id)
  })
})

