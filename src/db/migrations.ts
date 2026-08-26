import type { Database } from 'bun:sqlite'

export const DEFAULT_TENANT_ID = 'tenant_default'
export const LEGACY_ADMIN_ID = 'usr_legacy_admin'

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
