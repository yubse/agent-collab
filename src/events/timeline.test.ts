import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { runMigrations } from '../db/migrations.ts'
import { appendTimelineEvent, parseTimelineMetadata } from './timeline.ts'

function dbForEvents() {
  const db = new Database(':memory:'); db.run('PRAGMA foreign_keys=ON')
  db.run(`CREATE TABLE group_conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0)`)
  db.run(`CREATE TABLE group_conversation_members (conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY(conversation_id, member_id))`)
  db.run(`CREATE TABLE group_messages (id TEXT PRIMARY KEY, ts TEXT NOT NULL, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_model TEXT, text TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]', mentions TEXT NOT NULL DEFAULT '[]', reply_to TEXT, message_type TEXT NOT NULL DEFAULT 'chat', task_id TEXT, meta TEXT NOT NULL DEFAULT '{}')`)
  db.run(`CREATE TABLE group_tasks (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL)`)
  db.run(`CREATE TABLE tasks_v2 (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', current_phase TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, created_by TEXT NOT NULL, closed_at TEXT, closed_by TEXT, updated_at TEXT NOT NULL)`)
  db.run(`CREATE TABLE actor_channel_seen (actor_id TEXT NOT NULL, channel TEXT NOT NULL, last_seen_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(actor_id, channel))`)
  db.run(`INSERT INTO group_conversations VALUES ('c','C','2026-01-01','admin',0)`)
  runMigrations(db); return db
}

describe('D5 Event Timeline', () => {
  test('migration is repeatable and event rows are append-only', () => {
    const db = dbForEvents(); runMigrations(db)
    expect((db.prepare(`SELECT version FROM schema_migrations WHERE version=12`).get() as any).version).toBe(12)
    expect(appendTimelineEvent(db, { channelId:'c', eventType:'message.created', actorType:'human', actorId:'u', targetType:'message', targetId:'m', correlationId:'m:1', metadata:{safe:true} })).toBe(true)
    expect(appendTimelineEvent(db, { channelId:'c', eventType:'message.created', actorType:'human', actorId:'u', targetType:'message', targetId:'m', correlationId:'m:1' })).toBe(false)
    expect(() => db.run(`UPDATE events SET actor_id='x'`)).toThrow()
    expect(parseTimelineMetadata(db.prepare('SELECT * FROM events').get())).toMatchObject({ event_type:'message.created', metadata:{safe:true} })
  })
})
