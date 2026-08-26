import type { Database } from 'bun:sqlite'
import { randomBytes, randomInt, randomUUID } from 'crypto'
import { hashSecret } from '../auth/user-auth.ts'

export type ConnectorDevice = {
  id: string
  user_id: string
  device_name: string
  status: string
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export function createPairingCode(db: Database, userId: string, ttlMs = 10 * 60_000): { code: string; expiresAt: string } {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    try {
      db.run(`INSERT INTO connector_pairing_codes (id, user_id, code_hash, expires_at, used_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)`, [`pair_${randomUUID()}`, userId, hashSecret(code), expiresAt, now.toISOString()])
      return { code, expiresAt }
    } catch {}
  }
  throw new Error('unable to allocate pairing code')
}

export function redeemPairingCode(db: Database, code: string, deviceName: string, now = new Date()): { device: ConnectorDevice; deviceToken: string } {
  const cleanName = deviceName.trim().slice(0, 100)
  if (!cleanName) throw new Error('device_name required')
  db.run('BEGIN IMMEDIATE')
  try {
    const pair = db.prepare(`SELECT id, user_id FROM connector_pairing_codes
      WHERE code_hash=? AND used_at IS NULL AND expires_at>?`).get(hashSecret(code.trim()), now.toISOString()) as any
    if (!pair) throw new Error('pairing code invalid or expired')
    const deviceToken = randomBytes(32).toString('base64url')
    const deviceId = `dev_${randomUUID()}`
    const timestamp = now.toISOString()
    db.run(`UPDATE connector_pairing_codes SET used_at=? WHERE id=? AND used_at IS NULL`, [timestamp, pair.id])
    db.run(`INSERT INTO connector_devices
      (id, user_id, device_name, device_token_hash, status, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'offline', NULL, ?, ?)`, [
      deviceId, pair.user_id, cleanName, hashSecret(deviceToken), timestamp, timestamp,
    ])
    db.run('COMMIT')
    return { device: deviceById(db, deviceId)!, deviceToken }
  } catch (error) {
    try { db.run('ROLLBACK') } catch {}
    throw error
  }
}

export function authenticateDevice(db: Database, deviceToken: string): ConnectorDevice | null {
  return (db.prepare(`SELECT id, user_id, device_name, status, last_seen_at, created_at, updated_at
    FROM connector_devices WHERE device_token_hash=?`).get(hashSecret(deviceToken)) as ConnectorDevice) || null
}

export function deviceById(db: Database, deviceId: string): ConnectorDevice | null {
  return (db.prepare(`SELECT id, user_id, device_name, status, last_seen_at, created_at, updated_at
    FROM connector_devices WHERE id=?`).get(deviceId) as ConnectorDevice) || null
}

export function listDevices(db: Database, userId: string): ConnectorDevice[] {
  return db.prepare(`SELECT id, user_id, device_name, status, last_seen_at, created_at, updated_at
    FROM connector_devices WHERE user_id=? ORDER BY created_at DESC`).all(userId) as ConnectorDevice[]
}

export function setDeviceStatus(db: Database, deviceId: string, status: 'online' | 'offline'): void {
  const now = new Date().toISOString()
  db.run(`UPDATE connector_devices SET status=?, last_seen_at=?, updated_at=? WHERE id=?`, [status, now, now, deviceId])
}

