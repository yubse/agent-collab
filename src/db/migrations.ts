import type { Database } from 'bun:sqlite'

export const DEFAULT_TENANT_ID = 'tenant_default'
export const LEGACY_ADMIN_ID = 'usr_legacy_admin'

// D1 migration needs a stable snapshot of ids that have historically appeared as
// Agent senders. This is migration data, not a second Agent-definition registry.
const HISTORICAL_AGENT_IDS = [
  'creative', 'brand', 'product', 'content', 'market', 'moderator', 'director',
  'agent1', 'agent2', 'social', 'growth',
] as const

type Migration = {
  version: number
  name: string
  up: (db: Database) => void
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

function addColumn(db: Database, table: string, definition: string): void {
  const column = definition.trim().split(/\s+/)[0]
  if (!hasColumn(db, table, column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'multi_user_foundation',
    up(db) {
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id, username)`)

      db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, expires_at)`)

      db.run(`CREATE TABLE IF NOT EXISTS agent_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, agent_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_agent_memories_owner ON agent_memories(user_id, agent_id)`)

      db.run(`CREATE TABLE IF NOT EXISTS connector_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        device_token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_connector_devices_owner ON connector_devices(user_id, status)`)

      db.run(`CREATE TABLE IF NOT EXISTS connector_pairing_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_pairing_codes_owner ON connector_pairing_codes(user_id, expires_at)`)
    },
  },
  {
    version: 2,
    name: 'legacy_content_ownership',
    up(db) {
      const now = new Date().toISOString()
      // A placeholder password hash is replaced during auth bootstrap. Keeping the
      // migration independent from Bun.password makes schema upgrades deterministic.
      db.run(`INSERT OR IGNORE INTO users
        (id, tenant_id, username, display_name, password_hash, role, created_at, updated_at)
        VALUES (?, ?, 'admin', 'Administrator', '!bootstrap-required!', 'admin', ?, ?)`,
        [LEGACY_ADMIN_ID, DEFAULT_TENANT_ID, now, now])

      addColumn(db, 'group_conversations', `user_id TEXT NOT NULL DEFAULT '${LEGACY_ADMIN_ID}'`)
      addColumn(db, 'group_messages', `user_id TEXT NOT NULL DEFAULT '${LEGACY_ADMIN_ID}'`)
      addColumn(db, 'group_tasks', `user_id TEXT NOT NULL DEFAULT '${LEGACY_ADMIN_ID}'`)
      addColumn(db, 'tasks_v2', `user_id TEXT NOT NULL DEFAULT '${LEGACY_ADMIN_ID}'`)
      addColumn(db, 'tasks_v2', `conversation_id TEXT`)
      addColumn(db, 'actor_channel_seen', `user_id TEXT NOT NULL DEFAULT '${LEGACY_ADMIN_ID}'`)

      db.run(`UPDATE group_conversations SET user_id=? WHERE user_id IS NULL OR user_id=''`, [LEGACY_ADMIN_ID])
      db.run(`UPDATE group_messages SET user_id=? WHERE user_id IS NULL OR user_id=''`, [LEGACY_ADMIN_ID])
      db.run(`UPDATE group_tasks SET user_id=? WHERE user_id IS NULL OR user_id=''`, [LEGACY_ADMIN_ID])
      db.run(`UPDATE tasks_v2 SET user_id=? WHERE user_id IS NULL OR user_id=''`, [LEGACY_ADMIN_ID])
      db.run(`UPDATE actor_channel_seen SET user_id=? WHERE user_id IS NULL OR user_id=''`, [LEGACY_ADMIN_ID])

      db.run(`CREATE INDEX IF NOT EXISTS idx_group_conversations_owner ON group_conversations(user_id, created_at)`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_group_messages_owner_conv_ts ON group_messages(user_id, conversation_id, ts)`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_group_tasks_owner ON group_tasks(user_id, updated_at)`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_v2_owner ON tasks_v2(user_id, updated_at)`)
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_seen_owner_actor_channel ON actor_channel_seen(user_id, actor_id, channel)`)
    },
  },
  {
    version: 3,
    name: 'user_scoped_seen_marks',
    up(db) {
      db.run(`ALTER TABLE actor_channel_seen RENAME TO actor_channel_seen_legacy`)
      db.run(`CREATE TABLE actor_channel_seen (
        user_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        last_seen_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, actor_id, channel),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`)
      db.run(`INSERT OR IGNORE INTO actor_channel_seen (user_id, actor_id, channel, last_seen_id, updated_at)
        SELECT COALESCE(NULLIF(user_id, ''), '${LEGACY_ADMIN_ID}'), actor_id, channel, last_seen_id, updated_at
        FROM actor_channel_seen_legacy`)
      db.run(`DROP TABLE actor_channel_seen_legacy`)
    },
  },
  {
    version: 4,
    name: 'user_scoped_uploads',
    up(db) {
      db.run(`CREATE TABLE IF NOT EXISTS uploaded_assets (
        filename TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_uploaded_assets_owner ON uploaded_assets(user_id, created_at)`)
    },
  },
  {
    version: 5,
    name: 'connector_device_identity',
    up(db) {
      addColumn(db, 'connector_devices', 'platform TEXT')
      addColumn(db, 'connector_devices', 'connector_version TEXT')
    },
  },
  {
    version: 6,
    name: 'channel_membership_and_message_actors',
    up(db) {
      const now = new Date().toISOString()
      addColumn(db, 'group_conversations', `scope TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'shared'))`)
      addColumn(db, 'group_conversations', 'owner_user_id TEXT')
      addColumn(db, 'group_conversations', `updated_at TEXT NOT NULL DEFAULT ''`)
      db.run(`UPDATE group_conversations
        SET scope='private',
            owner_user_id=COALESCE(NULLIF(owner_user_id, ''), user_id),
            updated_at=CASE WHEN updated_at='' THEN COALESCE(NULLIF(created_at, ''), ?) ELSE updated_at END`, [now])

      db.run(`CREATE TABLE IF NOT EXISTS channel_memberships (
        channel_id TEXT NOT NULL,
        member_type TEXT NOT NULL CHECK (member_type IN ('human', 'agent')),
        member_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'moderator', 'member')),
        joined_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        left_at TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
        PRIMARY KEY (channel_id, member_type, member_id),
        FOREIGN KEY (channel_id) REFERENCES group_conversations(id) ON DELETE CASCADE
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_channel_memberships_member
        ON channel_memberships(member_type, member_id, status, channel_id)`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_channel_memberships_channel
        ON channel_memberships(channel_id, status, member_type)`)

      db.run(`INSERT OR IGNORE INTO channel_memberships
        (channel_id, member_type, member_id, role, joined_at, updated_at, left_at, status)
        SELECT id, 'human', owner_user_id, 'owner',
               COALESCE(NULLIF(created_at, ''), ?), ?, NULL, 'active'
        FROM group_conversations
        WHERE owner_user_id IS NOT NULL AND owner_user_id != ''`, [now, now])

      const legacyMembersExist = db.prepare(`SELECT name FROM sqlite_master
        WHERE type='table' AND name='group_conversation_members'`).get()
      if (legacyMembersExist) {
        const placeholders = HISTORICAL_AGENT_IDS.map(() => '?').join(',')
        db.run(`INSERT OR IGNORE INTO channel_memberships
          (channel_id, member_type, member_id, role, joined_at, updated_at, left_at, status)
          SELECT m.conversation_id, 'agent', m.member_id, 'member',
                 COALESCE(NULLIF(m.added_at, ''), NULLIF(c.created_at, ''), ?), ?, NULL, 'active'
          FROM group_conversation_members m
          JOIN group_conversations c ON c.id=m.conversation_id
          WHERE m.member_id IN (${placeholders})`, [now, now, ...HISTORICAL_AGENT_IDS])
      }

      addColumn(db, 'group_messages', 'sender_actor_type TEXT')
      addColumn(db, 'group_messages', 'sender_actor_id TEXT')
      addColumn(db, 'group_messages', 'execution_owner_user_id TEXT')
      addColumn(db, 'group_messages', 'trigger_message_id TEXT')
      addColumn(db, 'group_messages', 'trigger_actor_id TEXT')

      db.run(`UPDATE group_messages
        SET sender_actor_type='system', sender_actor_id='system'
        WHERE sender_id='system' AND sender_actor_type IS NULL`)
      const actorPlaceholders = HISTORICAL_AGENT_IDS.map(() => '?').join(',')
      db.run(`UPDATE group_messages
        SET sender_actor_type='agent', sender_actor_id=sender_id
        WHERE sender_id IN (${actorPlaceholders}) AND sender_actor_type IS NULL`, [...HISTORICAL_AGENT_IDS])
      db.run(`UPDATE group_messages
        SET sender_actor_type='human',
            sender_actor_id=(SELECT c.owner_user_id FROM group_conversations c WHERE c.id=group_messages.conversation_id)
        WHERE sender_id='admin'
          AND sender_actor_type IS NULL
          AND EXISTS (
            SELECT 1 FROM group_conversations c
            WHERE c.id=group_messages.conversation_id
              AND c.owner_user_id IS NOT NULL AND c.owner_user_id!=''
          )`)
    },
  },
  {
    version: 7,
    name: 'channel_threads',
    up(db) {
      db.run(`CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        root_message_id TEXT NOT NULL UNIQUE,
        created_by_actor_type TEXT NOT NULL CHECK (created_by_actor_type IN ('human', 'agent', 'system')),
        created_by_actor_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES group_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (root_message_id) REFERENCES group_messages(id) ON DELETE CASCADE
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_threads_channel_updated
        ON threads(channel_id, updated_at)`)
      addColumn(db, 'group_messages', 'thread_id TEXT')
      db.run(`CREATE INDEX IF NOT EXISTS idx_group_messages_thread_ts
        ON group_messages(thread_id, ts)`)
    },
  },
  {
    version: 8,
    name: 'secure_assets_and_meeting_recordings',
    up(db) {
      addColumn(db, 'uploaded_assets', `mime_type TEXT NOT NULL DEFAULT 'application/octet-stream'`)
      addColumn(db, 'uploaded_assets', `checksum TEXT NOT NULL DEFAULT ''`)
      addColumn(db, 'uploaded_assets', `asset_type TEXT NOT NULL DEFAULT 'generic' CHECK (asset_type IN ('generic', 'audio', 'meeting_recording'))`)

      db.run(`CREATE TABLE IF NOT EXISTS message_assets (
        message_id TEXT NOT NULL,
        asset_filename TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        added_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, asset_filename),
        FOREIGN KEY (message_id) REFERENCES group_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (asset_filename) REFERENCES uploaded_assets(filename) ON DELETE CASCADE,
        FOREIGN KEY (added_by_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_message_assets_channel_asset
        ON message_assets(channel_id, asset_filename)`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_message_assets_asset
        ON message_assets(asset_filename)`)

      // Normalize all existing JSON attachment references for which an asset row exists.
      const knownAssets = new Set((db.prepare(`SELECT filename FROM uploaded_assets`).all() as any[]).map((row) => String(row.filename)))
      const messages = db.prepare(`SELECT id, conversation_id, user_id, sender_actor_type, sender_actor_id,
        images, files, ts FROM group_messages`).all() as any[]
      const insert = db.prepare(`INSERT OR IGNORE INTO message_assets
        (message_id, asset_filename, channel_id, added_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?)`)
      for (const message of messages) {
        let images: any[] = []
        let files: any[] = []
        try { images = JSON.parse(message.images || '[]') } catch {}
        try { files = JSON.parse(message.files || '[]') } catch {}
        const filenames = [
          ...images.filter((item) => typeof item === 'string'),
          ...files.map((item) => typeof item === 'string' ? item : item?.server).filter(Boolean),
        ]
        const addedBy = message.sender_actor_type === 'human' && message.sender_actor_id
          ? String(message.sender_actor_id)
          : String(message.user_id)
        for (const filename of new Set(filenames.map(String))) {
          if (!knownAssets.has(filename)) continue
          insert.run(message.id, filename, message.conversation_id, addedBy, message.ts || new Date().toISOString())
        }
      }

      db.run(`CREATE TABLE IF NOT EXISTS meeting_recordings (
        id TEXT PRIMARY KEY,
        asset_filename TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        channel_id TEXT,
        source_message_id TEXT,
        title TEXT,
        meeting_at TEXT,
        participants_json TEXT NOT NULL DEFAULT '[]',
        language TEXT NOT NULL DEFAULT 'zh',
        duration_ms INTEGER,
        mime_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'transcribing', 'summarizing', 'completed', 'failed', 'cancelled')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (asset_filename) REFERENCES uploaded_assets(filename) ON DELETE RESTRICT,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES group_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (source_message_id) REFERENCES group_messages(id) ON DELETE SET NULL
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_meeting_recordings_owner_created
        ON meeting_recordings(owner_user_id, created_at)`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_meeting_recordings_channel_created
        ON meeting_recordings(channel_id, created_at)`)

      db.run(`CREATE TABLE IF NOT EXISTS helper_download_grants (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        recording_id TEXT NOT NULL,
        asset_filename TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (recording_id) REFERENCES meeting_recordings(id) ON DELETE CASCADE,
        FOREIGN KEY (asset_filename) REFERENCES uploaded_assets(filename) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (device_id) REFERENCES connector_devices(id) ON DELETE CASCADE
      )`)
      db.run(`CREATE INDEX IF NOT EXISTS idx_helper_download_grants_expiry
        ON helper_download_grants(expires_at, used_at)`)
    },
  },
]

export function runMigrations(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  for (const migration of MIGRATIONS) {
    const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version=?`).get(migration.version)
    if (applied) continue
    db.run('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      db.run(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`, [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ])
      db.run('COMMIT')
    } catch (error) {
      try { db.run('ROLLBACK') } catch {}
      throw error
    }
  }
}
