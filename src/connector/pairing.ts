import type { Database } from 'bun:sqlite'
import { randomBytes, randomUUID } from 'crypto'
import { hashSecret } from '../auth/user-auth.ts'

const PAIRING_TTL_MS = 5 * 60_000
const CLAIM_TTL_MS = 60_000
const PAIRING_TOKEN_BYTES = 32

export type ConnectorDevice = {
  id: string
  user_id: string
  device_name: string
  platform: string | null
  connector_version: string | null
  status: string
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export type PairingRequest = {
  pairingToken: string
  expiresAt: string
}

function normalizePairingToken(value: string): string {
  const token = value.trim()
  // 128 bits require at least 22 base64url characters. Newly issued tokens are
  // 256 bits (43 chars); this lower bound also makes legacy 6-digit codes invalid.
  if (!/^[A-Za-z0-9_-]{22,200}$/.test(token)) throw new Error('pairing token invalid or expired')
  return token
}

export function createPairingRequest(
  db: Database,
  userId: string,
  ttlMs = PAIRING_TTL_MS,
): PairingRequest {
  const now = new Date()
  const boundedTtlMs = Math.min(Math.max(1, ttlMs), PAIRING_TTL_MS)
  const expiresAt = new Date(now.getTime() + boundedTtlMs).toISOString()
  db.run(`DELETE FROM connector_pairing_codes WHERE expires_at<=? OR used_at IS NOT NULL`, [now.toISOString()])
  for (let attempt = 0; attempt < 3; attempt++) {
    const pairingToken = randomBytes(PAIRING_TOKEN_BYTES).toString('base64url')
    try {
      db.run(`INSERT INTO connector_pairing_codes (id, user_id, code_hash, expires_at, used_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)`, [
        `pair_${randomUUID()}`, userId, hashSecret(pairingToken), expiresAt, now.toISOString(),
      ])
      return { pairingToken, expiresAt }
    } catch {}
  }
  throw new Error('unable to create pairing request')
}

export function createClaimRequest(db: Database, userId: string, ttlMs = CLAIM_TTL_MS): PairingRequest {
  return createPairingRequest(db, userId, Math.min(ttlMs, CLAIM_TTL_MS))
}

export function completePairingRequest(
  db: Database,
  input: {
    pairingToken: string
    deviceId: string
    deviceName: string
    platform: string
    connectorVersion: string
  },
  now = new Date(),
): { device: ConnectorDevice; deviceCredential: string; alreadyBound: boolean } {
  const pairingToken = normalizePairingToken(input.pairingToken)
  const deviceId = input.deviceId.trim()
  const cleanName = input.deviceName.trim().slice(0, 100)
  const platform = input.platform.trim().slice(0, 50)
  const connectorVersion = input.connectorVersion.trim().slice(0, 50)
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(deviceId)) throw new Error('device_id invalid')
  if (!cleanName) throw new Error('device_name required')
  if (!platform) throw new Error('platform required')
  if (!connectorVersion) throw new Error('connector_version required')
  db.run('BEGIN IMMEDIATE')
  try {
    const pair = db.prepare(`SELECT id, user_id FROM connector_pairing_codes
      WHERE code_hash=? AND used_at IS NULL AND expires_at>?`)
      .get(hashSecret(pairingToken), now.toISOString()) as any
    if (!pair) throw new Error('pairing token invalid or expired')

    const existing = deviceById(db, deviceId)
    if (existing && existing.user_id !== pair.user_id) {
      throw new Error('DEVICE_ALREADY_BOUND_TO_ANOTHER_USER')
    }

    const deviceCredential = randomBytes(32).toString('base64url')
    const timestamp = now.toISOString()
    // Delete, rather than merely mark, so a successful token is immediately
    // unusable and no longer retained as a pairing credential.
    const deleted = db.prepare(`DELETE FROM connector_pairing_codes WHERE id=? AND used_at IS NULL`).run(pair.id)
    if (deleted.changes !== 1) throw new Error('pairing token invalid or expired')
    if (existing) {
      db.run(`UPDATE connector_devices
        SET device_name=?, platform=?, connector_version=?, device_token_hash=?, updated_at=?
        WHERE id=? AND user_id=?`, [
        cleanName, platform, connectorVersion, hashSecret(deviceCredential), timestamp, deviceId, pair.user_id,
      ])
    } else {
      db.run(`INSERT INTO connector_devices
        (id, user_id, device_name, platform, connector_version, device_token_hash, status, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'offline', NULL, ?, ?)`, [
        deviceId, pair.user_id, cleanName, platform, connectorVersion, hashSecret(deviceCredential), timestamp, timestamp,
      ])
    }
    db.run('COMMIT')
    return { device: deviceById(db, deviceId)!, deviceCredential, alreadyBound: Boolean(existing) }
  } catch (error) {
    try { db.run('ROLLBACK') } catch {}
    throw error
  }
}

export function authenticateDevice(db: Database, deviceToken: string): ConnectorDevice | null {
  return (db.prepare(`SELECT id, user_id, device_name, platform, connector_version, status, last_seen_at, created_at, updated_at
    FROM connector_devices WHERE device_token_hash=?`).get(hashSecret(deviceToken)) as ConnectorDevice) || null
}

export function deviceById(db: Database, deviceId: string): ConnectorDevice | null {
  return (db.prepare(`SELECT id, user_id, device_name, platform, connector_version, status, last_seen_at, created_at, updated_at
    FROM connector_devices WHERE id=?`).get(deviceId) as ConnectorDevice) || null
}

export function listDevices(db: Database, userId: string): ConnectorDevice[] {
  return db.prepare(`SELECT id, user_id, device_name, platform, connector_version, status, last_seen_at, created_at, updated_at
    FROM connector_devices WHERE user_id=? ORDER BY created_at DESC`).all(userId) as ConnectorDevice[]
}

export function unbindDevice(db: Database, userId: string, deviceId: string): ConnectorDevice | null {
  const cleanDeviceId = deviceId.trim()
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(cleanDeviceId)) return null
  const device = deviceById(db, cleanDeviceId)
  if (!device || device.user_id !== userId) return null
  const deleted = db.prepare(`DELETE FROM connector_devices WHERE id=? AND user_id=?`).run(cleanDeviceId, userId)
  return deleted.changes === 1 ? device : null
}

export function setDeviceStatus(db: Database, deviceId: string, status: 'online' | 'offline'): void {
  const now = new Date().toISOString()
  db.run(`UPDATE connector_devices SET status=?, last_seen_at=?, updated_at=? WHERE id=?`, [status, now, now, deviceId])
}
