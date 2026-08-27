import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { runMigrations } from '../db/migrations.ts'
import { createUser } from '../auth/user-auth.ts'
import { ConnectorRegistry, type ConnectorSocket } from './registry.ts'
import { ConnectorDispatcher } from './dispatcher.ts'
import {
  authenticateDevice,
  completePairingRequest,
  createClaimRequest,
  createPairingRequest,
  listDevices,
} from './pairing.ts'
import { RemoteCodexProvider } from '../providers/remote-codex.ts'

class FakeSocket implements ConnectorSocket {
  sent: string[] = []
  closed = false
  send(data: string) { this.sent.push(data) }
  close() { this.closed = true }
}

function createLegacyTables(db: Database) {
  db.run(`CREATE TABLE group_conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0)`)
  db.run(`CREATE TABLE group_messages (id TEXT PRIMARY KEY, ts TEXT NOT NULL, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_model TEXT, text TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]', mentions TEXT NOT NULL DEFAULT '[]', reply_to TEXT, message_type TEXT NOT NULL DEFAULT 'chat', task_id TEXT, meta TEXT NOT NULL DEFAULT '{}')`)
  db.run(`CREATE TABLE group_tasks (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL)`)
  db.run(`CREATE TABLE tasks_v2 (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', current_phase TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, created_by TEXT NOT NULL, closed_at TEXT, closed_by TEXT, updated_at TEXT NOT NULL)`)
  db.run(`CREATE TABLE actor_channel_seen (actor_id TEXT NOT NULL, channel TEXT NOT NULL, last_seen_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(actor_id, channel))`)
}

describe('connector pairing', () => {
  let db: Database
  let userId: string
  let otherUserId: string
  beforeEach(async () => {
    db = new Database(':memory:')
    db.run('PRAGMA foreign_keys=ON')
    createLegacyTables(db)
    runMigrations(db)
    userId = (await createUser(db, { username: 'pair_user', displayName: 'Pair User', password: 'pair-password-123' })).id
    otherUserId = (await createUser(db, { username: 'other_user', displayName: 'Other User', password: 'other-password-123' })).id
  })

  test('test_pairing_token_single_use', () => {
    const pair = createPairingRequest(db, userId)
    completePairingRequest(db, pairingInput(pair.pairingToken, 'dev_first-device', 'First Device'))
    expect(() => completePairingRequest(db, pairingInput(pair.pairingToken, 'dev_second-device', 'Second Device'))).toThrow('invalid or expired')
  })

  test('test_pairing_token_expiration', () => {
    const pair = createPairingRequest(db, userId, 1_000)
    const later = new Date(Date.now() + 2_000)
    expect(() => completePairingRequest(db, pairingInput(pair.pairingToken, 'dev_late-device', 'Late Device'), later)).toThrow('invalid or expired')
  })

  test('test_claim_single_use', () => {
    const claim = createClaimRequest(db, userId)
    completePairingRequest(db, pairingInput(claim.pairingToken, 'dev_claim-once', 'Claim Once'))
    expect(() => completePairingRequest(db, pairingInput(claim.pairingToken, 'dev_claim-twice', 'Claim Twice')))
      .toThrow('invalid or expired')
  })

  test('test_claim_expiration', () => {
    const claim = createClaimRequest(db, userId, 1_000)
    const later = new Date(Date.now() + 2_000)
    expect(() => completePairingRequest(db, pairingInput(claim.pairingToken, 'dev_expired-claim', 'Expired Claim'), later))
      .toThrow('invalid or expired')
    expect(Date.parse(claim.expiresAt) - Date.now()).toBeLessThanOrEqual(1_000)
  })

  test('test_device_auto_bound_to_current_user', () => {
    const pair = createPairingRequest(db, userId)
    const result = completePairingRequest(db, pairingInput(pair.pairingToken, 'dev_tina-macbook', 'Tina MacBook'))
    expect(result.device.user_id).toBe(userId)
    expect(result.device.platform).toBe('darwin')
    expect(result.device.connector_version).toBe('0.1.0')
    expect(listDevices(db, otherUserId)).toHaveLength(0)
    expect(pair.pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.deviceCredential.length).toBeGreaterThan(30)
    expect(authenticateDevice(db, result.deviceCredential)?.id).toBe(result.device.id)
  })

  test('test_existing_device_not_duplicated', () => {
    const first = createPairingRequest(db, userId)
    completePairingRequest(db, pairingInput(first.pairingToken, 'dev_same-installation', 'MacBook Pro'))
    const second = createPairingRequest(db, userId)
    const result = completePairingRequest(db, pairingInput(second.pairingToken, 'dev_same-installation', 'MacBook Pro'))
    expect(result.alreadyBound).toBe(true)
    expect(listDevices(db, userId)).toHaveLength(1)
  })

  test('test_device_bound_to_other_user_rejected', () => {
    const first = createPairingRequest(db, userId)
    completePairingRequest(db, pairingInput(first.pairingToken, 'dev_shared-installation', 'Shared Mac'))
    const otherPair = createPairingRequest(db, otherUserId)
    expect(() => completePairingRequest(db, pairingInput(otherPair.pairingToken, 'dev_shared-installation', 'Shared Mac')))
      .toThrow('DEVICE_ALREADY_BOUND_TO_ANOTHER_USER')
    expect(listDevices(db, userId)).toHaveLength(1)
    expect(listDevices(db, otherUserId)).toHaveLength(0)
  })
})

function pairingInput(pairingToken: string, deviceId: string, deviceName: string) {
  return {
    pairingToken,
    deviceId,
    deviceName,
    platform: 'darwin',
    connectorVersion: '0.1.0',
  }
}

describe('connector dispatch isolation', () => {
  const timeouts = { requestAckTimeoutMs: 1_000, serverPendingTimeoutMs: 2_000 }

  test('test_remote_provider_dispatches_correct_user', async () => {
    const registry = new ConnectorRegistry()
    const socketA = new FakeSocket()
    const socketB = new FakeSocket()
    registry.register({ deviceId: 'dev-a', userId: 'user-a', deviceName: 'A', socket: socketA })
    registry.register({ deviceId: 'dev-b', userId: 'user-b', deviceName: 'B', socket: socketB })
    const dispatcher = new ConnectorDispatcher(registry, timeouts)
    const provider = new RemoteCodexProvider(dispatcher, registry, { userId: 'user-b', conversationId: 'conv-b', agentId: 'social' })
    const events: any[] = []
    provider.onEvent((event) => { events.push(event) })
    const sendPromise = provider.send('hello B')
    expect(socketA.sent).toHaveLength(0)
    expect(socketB.sent).toHaveLength(1)
    const request = JSON.parse(socketB.sent[0])
    expect(request.user_id).toBe('user-b')
    expect(request.conversation_id).toBe('conv-b')
    expect(dispatcher.handleAck('dev-b', 'user-b', {
      type: 'execution_ack', request_id: request.request_id, status: 'running', acknowledged_at: new Date().toISOString(),
    })).toBe(true)
    expect(dispatcher.pendingState(request.request_id)).toBe('running')
    dispatcher.handleResult('dev-b', 'user-b', { type: 'execution_result', request_id: request.request_id, status: 'success', content: 'answer B' })
    await sendPromise
    expect(events.find((event) => event.type === 'assistant')?.text).toBe('answer B')
  })

  test('test_connector_cannot_impersonate_user', async () => {
    const registry = new ConnectorRegistry()
    const socketA = new FakeSocket()
    const socketB = new FakeSocket()
    registry.register({ deviceId: 'dev-a', userId: 'user-a', deviceName: 'A', socket: socketA })
    registry.register({ deviceId: 'dev-b', userId: 'user-b', deviceName: 'B', socket: socketB })
    const dispatcher = new ConnectorDispatcher(registry, timeouts)
    const resultPromise = dispatcher.dispatch({ user_id: 'user-a', conversation_id: 'conv-a', agent_id: 'social', prompt: 'secret' })
    const request = JSON.parse(socketA.sent[0])
    expect(dispatcher.handleResult('dev-b', 'user-b', { type: 'execution_result', request_id: request.request_id, status: 'success', content: 'forged' })).toBe(false)
    expect(dispatcher.pendingCount()).toBe(1)
    dispatcher.handleResult('dev-a', 'user-a', { type: 'execution_result', request_id: request.request_id, status: 'success', content: 'real' })
    expect((await resultPromise).content).toBe('real')
  })

  test('test_disconnected_connector_returns_clear_error', async () => {
    const registry = new ConnectorRegistry()
    const socket = new FakeSocket()
    registry.register({ deviceId: 'dev-a', userId: 'user-a', deviceName: 'A', socket })
    const dispatcher = new ConnectorDispatcher(registry, timeouts)
    const result = dispatcher.dispatch({ user_id: 'user-a', conversation_id: 'conv-a', agent_id: 'social', prompt: 'hello' })
    registry.unregister('dev-a', socket)
    await expect(result).rejects.toThrow('connector disconnected')
    await expect(dispatcher.dispatch({ user_id: 'user-a', conversation_id: 'conv-a', agent_id: 'social', prompt: 'again' })).rejects.toThrow('CODEX_CONNECTOR_OFFLINE')
  })

  test('test_duplicate_execution_result_is_ignored', async () => {
    const registry = new ConnectorRegistry()
    const socket = new FakeSocket()
    registry.register({ deviceId: 'dev-a', userId: 'user-a', deviceName: 'A', socket })
    const dispatcher = new ConnectorDispatcher(registry, timeouts)
    const resultPromise = dispatcher.dispatch({ user_id: 'user-a', conversation_id: 'conv-a', agent_id: 'social', prompt: 'hello' })
    const request = JSON.parse(socket.sent[0])
    const result = { type: 'execution_result', request_id: request.request_id, status: 'success', content: 'one' } as const
    expect(dispatcher.handleResult('dev-a', 'user-a', result)).toBe(true)
    expect(dispatcher.handleResult('dev-a', 'user-a', result)).toBe(false)
    expect((await resultPromise).content).toBe('one')
  })

  test('ACK timeout does not resend an execution request', async () => {
    const registry = new ConnectorRegistry()
    const socket = new FakeSocket()
    registry.register({ deviceId: 'dev-a', userId: 'user-a', deviceName: 'A', socket })
    const dispatcher = new ConnectorDispatcher(registry, { requestAckTimeoutMs: 20, serverPendingTimeoutMs: 100 })
    const result = dispatcher.dispatch({ user_id: 'user-a', conversation_id: 'conv-a', agent_id: 'social', prompt: 'once' })
    await expect(result).rejects.toThrow('CONNECTOR_REQUEST_ACK_TIMEOUT')
    expect(socket.sent).toHaveLength(1)
  })
})
