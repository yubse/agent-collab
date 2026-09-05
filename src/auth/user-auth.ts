import type { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { LEGACY_ADMIN_ID } from '../db/migrations.ts'

export const SESSION_COOKIE = 'aicollab_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000

// Trusted LAN MVP only: anyone who can reach the selector can choose one of
// these profiles. The selected id is still exchanged for a server-side
// session; downstream APIs never trust a user_id supplied by the browser.
export const TRUSTED_LAN_PROFILES = [
  { username: 'wenyi', displayName: '文一' },
  { username: 'tina', displayName: 'Tina' },
  { username: 'liuting', displayName: '刘婷' },
] as const

export type AuthenticatedUser = {
  id: string
  tenant_id: string
  username: string
  display_name: string
  role: 'admin' | 'user'
}

export type SelectableProfile = Pick<AuthenticatedUser, 'id' | 'display_name'>

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function parseCookie(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of (header || '').split(';')) {
    const index = item.indexOf('=')
    if (index < 1) continue
    out[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim())
  }
  return out
}

export async function createUser(
  db: Database,
  input: { username: string; displayName: string; password: string; role?: 'admin' | 'user'; tenantId?: string },
): Promise<AuthenticatedUser> {
  const username = input.username.trim().toLowerCase()
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) throw new Error('username must be 3-40 lowercase letters, numbers, dot, dash or underscore')
  if (input.password.length < 10) throw new Error('password must contain at least 10 characters')
  const now = new Date().toISOString()
  const user: AuthenticatedUser = {
    id: `usr_${randomUUID()}`,
    tenant_id: input.tenantId || 'tenant_default',
    username,
    display_name: input.displayName.trim() || username,
    role: input.role || 'user',
  }
  const passwordHash = await Bun.password.hash(input.password, { algorithm: 'argon2id' })
  db.run(`INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    user.id, user.tenant_id, user.username, user.display_name, passwordHash, user.role, now, now,
  ])
  return user
}

export async function ensureDefaultProfiles(db: Database): Promise<AuthenticatedUser[]> {
  const profiles: AuthenticatedUser[] = []
  for (const profile of TRUSTED_LAN_PROFILES) {
    let user = db.prepare(`SELECT id, tenant_id, username, display_name, role
      FROM users WHERE username=? AND role='user'`).get(profile.username) as AuthenticatedUser | null
    if (!user) {
      // The random password is deliberately never exposed or stored outside
      // its Argon2 hash. These accounts are entered through select-profile.
      user = await createUser(db, {
        username: profile.username,
        displayName: profile.displayName,
        password: randomBytes(32).toString('base64url'),
      })
    } else if (user.display_name !== profile.displayName) {
      db.run(`UPDATE users SET display_name=?, updated_at=? WHERE id=?`, [
        profile.displayName,
        new Date().toISOString(),
        user.id,
      ])
      user = { ...user, display_name: profile.displayName }
    }
    profiles.push(user)
  }
  return profiles
}

export function listSelectableProfiles(db: Database): SelectableProfile[] {
  const rows = db.prepare(`SELECT id, username, display_name FROM users
    WHERE role='user' AND username IN (${TRUSTED_LAN_PROFILES.map(() => '?').join(', ')})`)
    .all(...TRUSTED_LAN_PROFILES.map(profile => profile.username)) as Array<SelectableProfile & { username: string }>
  const byUsername = new Map(rows.map(row => [row.username, row]))
  return TRUSTED_LAN_PROFILES.flatMap(profile => {
    const user = byUsername.get(profile.username)
    return user ? [{ id: user.id, display_name: user.display_name }] : []
  })
}

export function selectableProfileById(db: Database, profileId: string): AuthenticatedUser | null {
  if (!profileId) return null
  const user = db.prepare(`SELECT id, tenant_id, username, display_name, role FROM users
    WHERE id=? AND role='user' AND username IN (${TRUSTED_LAN_PROFILES.map(() => '?').join(', ')})`)
    .get(profileId, ...TRUSTED_LAN_PROFILES.map(profile => profile.username)) as AuthenticatedUser | null
  return user || null
}

export async function ensureLegacyAdminPassword(db: Database, password?: string): Promise<string | null> {
  const row = db.prepare(`SELECT password_hash FROM users WHERE id=?`).get(LEGACY_ADMIN_ID) as any
  if (!row || row.password_hash !== '!bootstrap-required!') return null
  if (!password) return null
  if (password.length < 10) throw new Error('password must contain at least 10 characters')
  const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
  db.run(`UPDATE users SET password_hash=?, updated_at=? WHERE id=?`, [passwordHash, new Date().toISOString(), LEGACY_ADMIN_ID])
  return password
}

export async function authenticatePassword(db: Database, username: string, password: string): Promise<AuthenticatedUser | null> {
  const row = db.prepare(`SELECT id, tenant_id, username, display_name, password_hash, role FROM users WHERE username=?`)
    .get(username.trim().toLowerCase()) as any
  if (!row || !await Bun.password.verify(password, row.password_hash)) return null
  const { password_hash: _ignored, ...user } = row
  return user as AuthenticatedUser
}

export function createSession(db: Database, userId: string, ttlMs = SESSION_TTL_MS): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  db.run(`INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [
    `ses_${randomUUID()}`, userId, hashSecret(token), expiresAt, now.toISOString(), now.toISOString(),
  ])
  return { token, expiresAt }
}

export function sessionCookie(token: string, secure: boolean, remember = true): string {
  const persistence = remember ? `; Max-Age=${SESSION_TTL_MS / 1000}` : ''
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${persistence}${secure ? '; Secure' : ''}`
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}

export function sessionTokenFromRequest(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Session ')) return auth.slice('Session '.length).trim() || null
  return parseCookie(req.headers.get('cookie'))[SESSION_COOKIE] || null
}

export function authenticatedUser(db: Database, req: Request, now = new Date()): AuthenticatedUser | null {
  const token = sessionTokenFromRequest(req)
  if (!token) return null
  const row = db.prepare(`SELECT u.id, u.tenant_id, u.username, u.display_name, u.role, s.id AS session_id, s.last_seen_at
    FROM user_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(hashSecret(token), now.toISOString()) as any
  if (!row) return null
  const lastSeenMs = Date.parse(String(row.last_seen_at || ''))
  if (!Number.isFinite(lastSeenMs) || now.getTime() - lastSeenMs >= SESSION_LAST_SEEN_THROTTLE_MS) {
    db.run(`UPDATE user_sessions SET last_seen_at=? WHERE id=?`, [now.toISOString(), row.session_id])
  }
  delete row.session_id
  delete row.last_seen_at
  return row as AuthenticatedUser
}

export function revokeSession(db: Database, req: Request): void {
  const token = sessionTokenFromRequest(req)
  if (token) db.run(`DELETE FROM user_sessions WHERE token_hash=?`, [hashSecret(token)])
}
