import type { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { LEGACY_ADMIN_ID } from '../db/migrations.ts'

export const SESSION_COOKIE = 'aicollab_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type AuthenticatedUser = {
  id: string
  tenant_id: string
  username: string
  display_name: string
  role: 'admin' | 'user'
}

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

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
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
  const row = db.prepare(`SELECT u.id, u.tenant_id, u.username, u.display_name, u.role, s.id AS session_id
    FROM user_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(hashSecret(token), now.toISOString()) as any
  if (!row) return null
  db.run(`UPDATE user_sessions SET last_seen_at=? WHERE id=?`, [now.toISOString(), row.session_id])
  delete row.session_id
  return row as AuthenticatedUser
}

export function revokeSession(db: Database, req: Request): void {
  const token = sessionTokenFromRequest(req)
  if (token) db.run(`DELETE FROM user_sessions WHERE token_hash=?`, [hashSecret(token)])
}
