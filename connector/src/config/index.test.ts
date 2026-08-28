import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { clearDeviceCredential, parseCodexWorkerCount, type ConnectorConfig } from './index.ts'

test('test_codex_worker_count_defaults_to_four_and_is_clamped', () => {
  expect(parseCodexWorkerCount(undefined)).toBe(4)
  expect(parseCodexWorkerCount('2')).toBe(2)
  expect(parseCodexWorkerCount('3')).toBe(3)
  expect(parseCodexWorkerCount('0')).toBe(1)
  expect(parseCodexWorkerCount('99')).toBe(4)
  expect(parseCodexWorkerCount('not-a-number')).toBe(4)
})

test('test_clear_device_credential_preserves_device_identity_and_codex_auth', () => {
  const appSupportDir = mkdtempSync(path.join(tmpdir(), 'aistudio-unbind-'))
  const credentialsDir = path.join(appSupportDir, 'credentials')
  const codexHome = path.join(appSupportDir, 'codex-home')
  const deviceFile = path.join(credentialsDir, 'device.json')
  const authFile = path.join(codexHome, 'auth.json')
  mkdirSync(credentialsDir, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(deviceFile, JSON.stringify({ device_id: 'dev_stable', device_token: 'must-disappear' }))
  writeFileSync(authFile, 'codex-auth-must-remain')
  chmodSync(deviceFile, 0o600)
  const config = {
    serverUrl: 'http://nas.local:3998', connectorWsUrl: 'ws://nas.local:3998/connector',
    deviceName: 'Test Mac', deviceId: 'dev_stable', appSupportDir, codexHome,
  } as ConnectorConfig

  try {
    clearDeviceCredential(config)
    const saved = JSON.parse(readFileSync(deviceFile, 'utf8'))
    expect(saved.device_id).toBe('dev_stable')
    expect(saved.device_token).toBeUndefined()
    expect(statSync(deviceFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(authFile, 'utf8')).toBe('codex-auth-must-remain')
  } finally {
    rmSync(appSupportDir, { recursive: true, force: true })
  }
})
