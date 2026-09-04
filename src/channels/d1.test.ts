import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createUser } from '../auth/user-auth.ts'
import { LEGACY_ADMIN_ID, runMigrations } from '../db/migrations.ts'
import {
  canManageMembers,
  canPostChannel,
  canReadChannel,
  canStopExecution,
  removeChannelMembership,
  upsertChannelMembership,
} from './access.ts'
import { resolveActor } from '../actors/resolver.ts'

function legacyDatabase(): Database {
  const db = new Database(':memory:')
  db.run('PRAGMA foreign_keys=ON')
  db.run(`CREATE TABLE group_conversations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
    created_by TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0
  )`)
  db.run(`CREATE TABLE group_conversation_members (
    conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, added_at TEXT NOT NULL,
    PRIMARY KEY(conversation_id, member_id)
  )`)
  db.run(`CREATE TABLE group_messages (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL, sender_model TEXT, text TEXT NOT NULL,
    images TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]',
    mentions TEXT NOT NULL DEFAULT '[]', reply_to TEXT,
    message_type TEXT NOT NULL DEFAULT 'chat', task_id TEXT, meta TEXT NOT NULL DEFAULT '{}'
  )`)
  db.run(`CREATE TABLE group_tasks (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL)`)
  db.run(`CREATE TABLE tasks_v2 (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '', current_phase TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL, created_by TEXT NOT NULL, closed_at TEXT, closed_by TEXT, updated_at TEXT NOT NULL
  )`)
  db.run(`CREATE TABLE actor_channel_seen (
    actor_id TEXT NOT NULL, channel TEXT NOT NULL, last_seen_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(actor_id, channel)
  )`)
  return db
}

describe('D1 migration', () => {
  test('migration is repeatable and backfills owner, Agent memberships and actors', () => {
    const db = legacyDatabase()
    db.run(`INSERT INTO group_conversations VALUES ('legacy-channel','Legacy','2026-01-01','admin',1)`)
    for (const member of ['admin', 'creative', 'market']) {
      db.run(`INSERT INTO group_conversation_members VALUES ('legacy-channel', ?, '2026-01-01')`, [member])
    }
    for (const [id, sender] of [['m-human', 'admin'], ['m-agent', 'creative'], ['m-system', 'system'], ['m-unknown', 'someone']]) {
      db.run(`INSERT INTO group_messages (id,ts,conversation_id,sender_id,text)
        VALUES (?, '2026-01-01', 'legacy-channel', ?, 'text')`, [id, sender])
    }

    runMigrations(db)
    runMigrations(db)

    const channel = db.prepare(`SELECT scope, owner_user_id, updated_at FROM group_conversations WHERE id='legacy-channel'`).get() as any
    expect(channel.scope).toBe('private')
    expect(channel.owner_user_id).toBe(LEGACY_ADMIN_ID)
    expect(channel.updated_at).not.toBe('')

    const memberships = db.prepare(`SELECT member_type, member_id, role FROM channel_memberships
      WHERE channel_id='legacy-channel' ORDER BY member_type DESC, member_id`).all() as any[]
    expect(memberships).toEqual([
      { member_type: 'human', member_id: LEGACY_ADMIN_ID, role: 'owner' },
      { member_type: 'agent', member_id: 'creative', role: 'member' },
      { member_type: 'agent', member_id: 'market', role: 'member' },
    ])
    expect(memberships.some((row) => row.member_id === 'admin')).toBe(false)

    const actors = db.prepare(`SELECT id, sender_actor_type, sender_actor_id FROM group_messages ORDER BY id`).all() as any[]
    expect(actors).toEqual([
      { id: 'm-agent', sender_actor_type: 'agent', sender_actor_id: 'creative' },
      { id: 'm-human', sender_actor_type: 'human', sender_actor_id: LEGACY_ADMIN_ID },
      { id: 'm-system', sender_actor_type: 'system', sender_actor_id: 'system' },
      { id: 'm-unknown', sender_actor_type: null, sender_actor_id: null },
    ])
    expect((db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version=6`).get() as any).n).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version=7`).get() as any).n).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version=9`).get() as any).n).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version=10`).get() as any).n).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version=12`).get() as any).n).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='transcriptions'`).get() as any).n).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='meeting_transcripts'`).get() as any).n).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='threads'`).get() as any).n).toBe(1)
    expect((db.prepare(`PRAGMA table_info(group_messages)`).all() as any[]).some((column) => column.name === 'thread_id')).toBe(true)
  })
})

describe('D1 channel access', () => {
  let db: Database
  let owner: any
  let moderator: any
  let member: any
  let outsider: any

  beforeEach(async () => {
    db = legacyDatabase()
    runMigrations(db)
    owner = await createUser(db, { username: 'owner_user', displayName: 'Owner', password: 'owner-password-1' })
    moderator = await createUser(db, { username: 'moderator_user', displayName: 'Moderator', password: 'moderator-password-1' })
    member = await createUser(db, { username: 'member_user', displayName: 'Member', password: 'member-password-1' })
    outsider = await createUser(db, { username: 'outsider_user', displayName: 'Outsider', password: 'outsider-password-1' })
    db.run(`INSERT INTO group_conversations
      (id,name,created_at,created_by,is_default,user_id,scope,owner_user_id,updated_at)
      VALUES ('shared-channel','Shared','2026-01-01',?,0,?,'shared',?,'2026-01-01')`, [owner.id, owner.id, owner.id])
    upsertChannelMembership(db, { channelId: 'shared-channel', memberType: 'human', memberId: owner.id, role: 'owner' })
    upsertChannelMembership(db, { channelId: 'shared-channel', memberType: 'human', memberId: moderator.id, role: 'moderator' })
    upsertChannelMembership(db, { channelId: 'shared-channel', memberType: 'human', memberId: member.id, role: 'member' })
  })

  test('non-member cannot read or post and shared channels never use owner fallback', () => {
    expect(canReadChannel(db, 'shared-channel', outsider.id)).toBe(false)
    expect(canPostChannel(db, 'shared-channel', outsider.id)).toBe(false)
    db.run(`UPDATE channel_memberships SET status='removed' WHERE channel_id='shared-channel' AND member_id=?`, [owner.id])
    expect(canReadChannel(db, 'shared-channel', owner.id)).toBe(false)
  })

  test('legacy owner fallback applies only to private channels without human memberships', () => {
    db.run(`INSERT INTO group_conversations
      (id,name,created_at,created_by,is_default,user_id,scope,owner_user_id,updated_at)
      VALUES ('legacy-private','Private','2026-01-01',?,0,?,'private',?,'2026-01-01')`, [owner.id, owner.id, owner.id])
    expect(canReadChannel(db, 'legacy-private', owner.id)).toBe(true)
    expect(canPostChannel(db, 'legacy-private', owner.id)).toBe(true)
    expect(canReadChannel(db, 'legacy-private', outsider.id)).toBe(false)
    upsertChannelMembership(db, { channelId: 'legacy-private', memberType: 'human', memberId: member.id, role: 'member' })
    expect(canReadChannel(db, 'legacy-private', owner.id)).toBe(false)
  })

  test('owner, moderator and member permissions are distinct', () => {
    expect(canManageMembers(db, 'shared-channel', owner.id, 'moderator')).toBe(true)
    expect(canManageMembers(db, 'shared-channel', moderator.id, 'member')).toBe(true)
    expect(canManageMembers(db, 'shared-channel', moderator.id, 'moderator')).toBe(false)
    expect(canManageMembers(db, 'shared-channel', member.id, 'member')).toBe(false)
    expect(canStopExecution(db, 'shared-channel', owner.id, outsider.id)).toBe(true)
    expect(canStopExecution(db, 'shared-channel', moderator.id, outsider.id)).toBe(true)
    expect(canStopExecution(db, 'shared-channel', member.id, member.id)).toBe(true)
    expect(canStopExecution(db, 'shared-channel', member.id, owner.id)).toBe(false)
  })

  test('the final owner cannot be removed', () => {
    expect(removeChannelMembership(db, {
      channelId: 'shared-channel', memberType: 'human', memberId: owner.id, actorUserId: owner.id,
    })).toEqual({ removed: false, error: 'LAST_OWNER' })
  })

  test('actor resolver uses existing User and Agent sources', () => {
    expect(resolveActor(db, 'human', member.id)?.display_name).toBe('Member')
    expect(resolveActor(db, 'agent', 'creative')?.display_name).toBe('创想家A')
    expect(resolveActor(db, 'system', 'system')?.display_name).toBe('System')
    expect(resolveActor(db, 'human', 'missing')).toBeNull()
  })
})
