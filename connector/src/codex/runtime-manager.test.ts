import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { ConnectorConfig } from '../config/index.ts'
import { ConnectorStateStore } from '../state/store.ts'
import { CodexRuntimeManager } from './runtime-manager.ts'

class FakeProvider {
  alive = true
  warmups = 0
  restarts = 0
  sends = 0
  account: any = null
  accountEvent: ((method: string, params: any) => void) | null = null
  event: ((event: any) => void) = () => {}
  error: ((error: any) => void) = () => {}
  selected: string | null = null
  get isAlive() { return this.alive }
  get sessionId() { return this.selected }
  selectThread(value: string | null) { this.selected = value }
  onEvent(callback: (event: any) => void) { this.event = callback }
  onError(callback: (error: any) => void) { this.error = callback }
  onAccountEvent(callback: (method: string, params: any) => void) { this.accountEvent = callback }
  async warmup() { this.warmups += 1; this.alive = true }
  async send() { this.sends += 1 }
  async interrupt() { return true }
  async close() { this.alive = false }
  async readAccount() { return { account: this.account, requiresOpenaiAuth: true } }
  async startChatGPTLogin() { return { type: 'chatgpt' as const, loginId: 'login_1', authUrl: 'https://chatgpt.com/auth/test' } }
  async restartProcess() { this.restarts += 1; this.alive = true }
}

let roots: string[] = []
let managers: CodexRuntimeManager[] = []
afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.stop()))
  managers = []
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function setup(account: any = null) {
  const root = mkdtempSync(path.join(tmpdir(), 'aistudio-runtime-'))
  roots.push(root)
  const bundled = path.join(root, 'bundle', 'codex')
  const managed = path.join(root, 'support', 'runtime', 'codex')
  mkdirSync(path.dirname(bundled), { recursive: true })
  Bun.write(bundled, 'fake official codex runtime')
  const provider = new FakeProvider()
  provider.account = account
  const config: ConnectorConfig = {
    serverUrl: 'http://127.0.0.1:3998', connectorWsUrl: null, deviceName: 'Test Mac',
    deviceId: 'dev_runtime-test', platform: 'darwin', connectorVersion: '0.2.0',
    webOrigin: 'http://127.0.0.1:3998', helperHost: '127.0.0.1', helperPort: 39481,
    deviceToken: null, pairingToken: null, codexBinary: 'codex', codexCwd: root,
    codexHome: path.join(root, 'codex-home'), appSupportDir: path.join(root, 'support'),
    managedCodexPath: managed, bundledCodexPath: bundled, useSystemCodex: false,
    stateDir: path.join(root, 'state'), connectTimeoutMs: 15_000, executionTimeoutMs: 300_000,
  }
  let opened = ''
  let providerCreations = 0
  const manager = new CodexRuntimeManager(config, new ConnectorStateStore(), {
    version: (binary) => existsSync(binary) ? 'codex-cli test-1' : null,
    provider: () => { providerCreations += 1; return provider as any },
    openUrl: async (url) => { opened = url },
  })
  managers.push(manager)
  return { manager, provider, config, opened: () => opened, providerCreations: () => providerCreations }
}

describe('CodexRuntimeManager', () => {
  test('test_runtime_manager_detects_runtime', async () => {
    const { manager, config } = setup()
    expect(manager.detect().runtimeInstalled).toBe(false)
    await manager.installIfNeeded()
    expect(manager.detect()).toMatchObject({ runtimeInstalled: true, runtimeVersion: 'codex-cli test-1', mode: 'managed' })
    expect(existsSync(config.managedCodexPath)).toBe(true)
  })

  test('test_runtime_manager_starts_runtime', async () => {
    const { manager, provider } = setup({ type: 'chatgpt' })
    await manager.start()
    expect(provider.warmups).toBe(1)
    expect(manager.isAlive).toBe(true)
    expect(manager.snapshot().status).toBe('CODEX_READY')
  })

  test('test_runtime_reused_between_requests', async () => {
    const { manager, provider, providerCreations } = setup({ type: 'chatgpt' })
    await manager.start()
    await manager.warmup()
    manager.selectThread('thread-a')
    await manager.send('one')
    await manager.send('two')
    expect(providerCreations()).toBe(1)
    expect(provider.warmups).toBe(1)
    expect(provider.sends).toBe(2)
  })

  test('test_runtime_restart_after_crash', async () => {
    const { manager, provider } = setup({ type: 'chatgpt' })
    await manager.start()
    provider.alive = false
    expect(await manager.healthCheck()).toBe(false)
    await manager.restart()
    expect(provider.restarts).toBe(1)
    expect(manager.snapshot().status).toBe('CODEX_READY')
  })

  test('test_codex_status_not_logged_in', async () => {
    const { manager } = setup(null)
    await manager.start()
    expect(manager.snapshot()).toMatchObject({ loggedIn: false, status: 'CODEX_NOT_LOGGED_IN' })
  })

  test('test_codex_login_uses_official_browser_without_exposing_url', async () => {
    const { manager, opened } = setup(null)
    await manager.start()
    const result = await manager.login()
    expect(result).toEqual({ started: true, status: 'CODEX_AUTHENTICATING' })
    expect(opened()).toStartWith('https://chatgpt.com/')
    expect(JSON.stringify(result)).not.toContain('chatgpt.com')
  })

  test('test_existing_codex_auth_reused_after_restart', async () => {
    const { manager, provider } = setup({ type: 'chatgpt' })
    await manager.start()
    await manager.restart()
    expect(manager.snapshot()).toMatchObject({ loggedIn: true, status: 'CODEX_READY' })
    expect(provider.restarts).toBe(1)
  })
})
