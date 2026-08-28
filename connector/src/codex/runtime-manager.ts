import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'fs'
import path from 'path'
import { CodexProvider, type CodexAccountSnapshot } from '../../../src/providers/codex.ts'
import type { AgentError, AgentEvent } from '../../../src/providers/provider.ts'
import type { AgentSendOpts } from '../../../src/providers/provider.ts'
import type { ConnectorConfig } from '../config/index.ts'
import type { ConnectorStateStore, CodexStatus } from '../state/store.ts'
import { PURE_CHAT_APP_SERVER_ARGS } from './options.ts'

export type CodexRuntimeSnapshot = {
  runtimeInstalled: boolean
  runtimeVersion: string | null
  loggedIn: boolean
  status: CodexStatus
  mode: 'managed' | 'system'
  lastError: string | null
}

type RuntimeProvider = Pick<CodexProvider,
  | 'isAlive'
  | 'sessionId'
  | 'selectThread'
  | 'onEvent'
  | 'onError'
  | 'onAccountEvent'
  | 'warmup'
  | 'send'
  | 'interrupt'
  | 'close'
  | 'readAccount'
  | 'startChatGPTLogin'
  | 'restartProcess'
>

type RuntimeDependencies = {
  version: (binary: string, env: Record<string, string | undefined>) => string | null
  copyRuntime: (source: string, destination: string) => void
  openUrl: (url: string) => Promise<void>
  provider: (binary: string, env: Record<string, string | undefined>) => RuntimeProvider
}

const defaultVersion = (binary: string, env: Record<string, string | undefined>): string | null => {
  try {
    const result = Bun.spawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
    if (result.exitCode !== 0) return null
    return new TextDecoder().decode(result.stdout).trim().split(/\r?\n/, 1)[0] || null
  } catch { return null }
}

const defaultCopyRuntime = (source: string, destination: string): void => {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  const staging = `${destination}.installing-${process.pid}`
  try { if (existsSync(staging)) unlinkSync(staging) } catch {}
  copyFileSync(source, staging)
  chmodSync(staging, 0o755)
  renameSync(staging, destination)
}

const defaultOpenUrl = async (url: string): Promise<void> => {
  if (process.platform !== 'darwin') throw new Error('CODEX_BROWSER_LOGIN_REQUIRES_MACOS')
  const child = Bun.spawn(['/usr/bin/open', url], {
    stdout: 'ignore', stderr: 'ignore', env: { ...process.env },
  })
  if (await child.exited !== 0) throw new Error('CODEX_BROWSER_OPEN_FAILED')
}

export class CodexRuntimeManager {
  private current: CodexRuntimeSnapshot
  private runtimeBinary: string | null = null
  private runtimeProvider: RuntimeProvider | null = null
  private startPromise: Promise<void> | null = null
  private loginPromise: Promise<void> | null = null
  private monitor: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempts = 0
  private stopping = false
  private selectedThread: string | null = null
  private eventCallback: ((event: AgentEvent) => void | Promise<void>) = () => {}
  private errorCallback: (error: AgentError) => void = () => {}
  private readonly deps: RuntimeDependencies

  constructor(
    private readonly config: ConnectorConfig,
    private readonly state: ConnectorStateStore,
    dependencies: Partial<RuntimeDependencies> = {},
  ) {
    this.current = {
      runtimeInstalled: false,
      runtimeVersion: null,
      loggedIn: false,
      status: 'CODEX_RUNTIME_NOT_INSTALLED',
      mode: config.useSystemCodex ? 'system' : 'managed',
      lastError: null,
    }
    this.deps = {
      version: dependencies.version || defaultVersion,
      copyRuntime: dependencies.copyRuntime || defaultCopyRuntime,
      openUrl: dependencies.openUrl || defaultOpenUrl,
      provider: dependencies.provider || ((binary, env) => new CodexProvider({
        label: 'connector:managed-app-server',
        binaryPath: binary,
        cwd: this.config.codexCwd,
        env,
        extraArgs: [...PURE_CHAT_APP_SERVER_ARGS],
        onDiagnostic: (event) => {
          if (event.stream === 'process') console.error(`[codex] status=exited code=${event.exitCode ?? 'unknown'}`)
          else console.error('[codex] status=diagnostic')
        },
      })),
    }
  }

  snapshot(): Readonly<CodexRuntimeSnapshot> { return { ...this.current } }
  get sessionId(): string | null { return this.runtimeProvider?.sessionId || null }
  get isAlive(): boolean { return this.runtimeProvider?.isAlive === true }

  detect(): CodexRuntimeSnapshot {
    const env = this.codexEnvironment()
    const candidate = this.config.useSystemCodex ? this.config.codexBinary : this.config.managedCodexPath
    const version = this.deps.version(candidate, env)
    if (version) {
      this.runtimeBinary = candidate
      this.update({ runtimeInstalled: true, runtimeVersion: version, lastError: null })
    } else {
      this.runtimeBinary = null
      this.update({
        runtimeInstalled: false,
        runtimeVersion: null,
        loggedIn: false,
        status: 'CODEX_RUNTIME_NOT_INSTALLED',
        lastError: null,
      })
    }
    return this.snapshot() as CodexRuntimeSnapshot
  }

  async installIfNeeded(): Promise<CodexRuntimeSnapshot> {
    const detected = this.detect()
    if (this.config.useSystemCodex) {
      if (!detected.runtimeInstalled) this.fail('CODEX_SYSTEM_FALLBACK_NOT_FOUND')
      return this.snapshot() as CodexRuntimeSnapshot
    }
    const bundled = this.config.bundledCodexPath
    const bundledVersion = bundled ? this.deps.version(bundled, this.codexEnvironment()) : null
    if (detected.runtimeInstalled && (!bundledVersion || bundledVersion === detected.runtimeVersion)) return detected
    if (!bundled || !bundledVersion) {
      this.fail('CODEX_BUNDLED_RUNTIME_NOT_AVAILABLE', 'CODEX_RUNTIME_NOT_INSTALLED')
      return this.snapshot() as CodexRuntimeSnapshot
    }
    this.update({ status: 'CODEX_RUNTIME_INSTALLING', lastError: null })
    try {
      this.deps.copyRuntime(bundled, this.config.managedCodexPath)
      const installedVersion = this.deps.version(this.config.managedCodexPath, this.codexEnvironment())
      if (!installedVersion) throw new Error('CODEX_RUNTIME_INSTALL_VERIFY_FAILED')
      this.runtimeBinary = this.config.managedCodexPath
      this.update({
        runtimeInstalled: true,
        runtimeVersion: installedVersion,
        loggedIn: false,
        status: 'CODEX_NOT_LOGGED_IN',
        lastError: null,
      })
    } catch (error: any) {
      this.fail(safeRuntimeError(error?.message))
    }
    return this.snapshot() as CodexRuntimeSnapshot
  }

  async start(): Promise<void> {
    if (this.runtimeProvider?.isAlive) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.monitor) clearInterval(this.monitor)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.monitor = null
    this.restartTimer = null
    await this.runtimeProvider?.close()
  }

  async restart(): Promise<void> {
    if (!this.runtimeProvider) return this.start()
    this.update({ status: 'CODEX_RUNTIME_INSTALLING', lastError: null })
    try {
      await this.runtimeProvider.restartProcess()
      await this.refreshAuth()
      this.restartAttempts = 0
    } catch (error: any) {
      this.fail(safeRuntimeError(error?.message))
      throw error
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.runtimeProvider?.isAlive) return false
    try {
      await this.refreshAuth()
      return true
    } catch { return false }
  }

  async login(): Promise<{ started: true; status: 'CODEX_AUTHENTICATING' }> {
    await this.start()
    if (!this.runtimeProvider) throw new Error('CODEX_RUNTIME_ERROR')
    if (this.current.status === 'CODEX_READY') return { started: true, status: 'CODEX_AUTHENTICATING' }
    if (!this.loginPromise) {
      this.loginPromise = (async () => {
        this.update({ status: 'CODEX_AUTHENTICATING', lastError: null })
        const login = await this.runtimeProvider!.startChatGPTLogin()
        const url = new URL(login.authUrl)
        if (url.protocol !== 'https:' || !isOfficialAuthHost(url.hostname)) throw new Error('CODEX_LOGIN_URL_REJECTED')
        await this.deps.openUrl(url.toString())
        void this.pollLoginCompletion()
      })().catch((error: any) => {
        this.fail(safeRuntimeError(error?.message))
        throw error
      }).finally(() => { this.loginPromise = null })
    }
    await this.loginPromise
    return { started: true, status: 'CODEX_AUTHENTICATING' }
  }

  selectThread(threadId: string | null): void {
    this.selectedThread = threadId
    this.runtimeProvider?.selectThread(threadId)
  }
  onEvent(callback: (event: AgentEvent) => void | Promise<void>): void {
    this.eventCallback = callback
    this.runtimeProvider?.onEvent(callback)
  }
  onError(callback: (error: AgentError) => void): void {
    this.errorCallback = callback
    this.runtimeProvider?.onError(callback)
  }
  async warmup(): Promise<void> { await this.start() }
  async send(text: string, opts?: AgentSendOpts): Promise<void> {
    await this.start()
    if (this.current.status !== 'CODEX_READY') await this.refreshAuth()
    if (this.current.status !== 'CODEX_READY') throw new Error('CODEX_NOT_LOGGED_IN')
    this.runtimeProvider!.selectThread(this.selectedThread)
    await this.runtimeProvider!.send(text, opts)
  }
  async interrupt(): Promise<boolean> { return this.runtimeProvider?.interrupt() || false }
  async close(): Promise<void> { await this.stop() }

  private async startInternal(): Promise<void> {
    this.stopping = false
    const installed = await this.installIfNeeded()
    if (!installed.runtimeInstalled || !this.runtimeBinary) throw new Error(installed.lastError || 'CODEX_RUNTIME_NOT_INSTALLED')
    mkdirSync(this.config.codexHome, { recursive: true, mode: 0o700 })
    if (!this.runtimeProvider) {
      this.runtimeProvider = this.deps.provider(this.runtimeBinary, this.codexEnvironment())
      this.runtimeProvider.onEvent(this.eventCallback)
      this.runtimeProvider.onError(this.errorCallback)
      this.runtimeProvider.onAccountEvent((method, params) => this.handleAccountEvent(method, params))
      this.runtimeProvider.selectThread(this.selectedThread)
    }
    try {
      await this.runtimeProvider.warmup()
      await this.refreshAuth()
      this.startMonitor()
    } catch (error: any) {
      this.fail(safeRuntimeError(error?.message))
      throw error
    }
  }

  private async refreshAuth(): Promise<void> {
    if (!this.runtimeProvider) throw new Error('CODEX_RUNTIME_ERROR')
    const account = await this.runtimeProvider.readAccount(false)
    this.applyAccount(account)
  }

  private applyAccount(account: CodexAccountSnapshot): void {
    const ready = Boolean(account.account) || account.requiresOpenaiAuth === false
    this.update({
      loggedIn: ready,
      status: ready ? 'CODEX_READY' : 'CODEX_NOT_LOGGED_IN',
      lastError: null,
    })
  }

  private handleAccountEvent(method: string, params: any): void {
    if (method === 'account/login/completed') {
      if (params?.success === true) void this.refreshAuth().catch(() => this.fail('CODEX_AUTH_STATUS_ERROR'))
      else this.fail('CODEX_LOGIN_FAILED', 'CODEX_NOT_LOGGED_IN')
      return
    }
    if (method === 'account/updated') {
      const ready = typeof params?.authMode === 'string' && params.authMode.length > 0
      this.update({ loggedIn: ready, status: ready ? 'CODEX_READY' : 'CODEX_NOT_LOGGED_IN', lastError: null })
    }
  }

  private async pollLoginCompletion(): Promise<void> {
    const deadline = Date.now() + 10 * 60_000
    while (!this.stopping && Date.now() < deadline && this.current.status === 'CODEX_AUTHENTICATING') {
      await Bun.sleep(2_000)
      try { await this.refreshAuth() } catch {}
    }
    if (this.current.status === 'CODEX_AUTHENTICATING') this.fail('CODEX_LOGIN_TIMEOUT', 'CODEX_NOT_LOGGED_IN')
  }

  private startMonitor(): void {
    if (this.monitor) return
    this.monitor = setInterval(() => {
      if (this.stopping || !this.runtimeProvider || this.runtimeProvider.isAlive || this.restartTimer) return
      this.fail('CODEX_RUNTIME_EXITED')
      const delays = [2_000, 5_000, 15_000, 30_000]
      const delay = delays[Math.min(this.restartAttempts, delays.length - 1)]
      this.restartAttempts += 1
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        void this.restart().catch(() => {})
      }, delay)
    }, 2_000)
  }

  private codexEnvironment(): Record<string, string | undefined> {
    return { CODEX_HOME: this.config.codexHome }
  }

  private update(patch: Partial<CodexRuntimeSnapshot>): void {
    this.current = { ...this.current, ...patch }
    this.state.setCodex(this.current.status, this.current.lastError)
  }

  private fail(error: string, status: CodexStatus = 'CODEX_RUNTIME_ERROR'): void {
    this.update({ status, lastError: error, loggedIn: false })
  }
}

function isOfficialAuthHost(hostname: string): boolean {
  return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')
    || hostname === 'openai.com' || hostname.endsWith('.openai.com')
}

function safeRuntimeError(message: string): string {
  if (/NOT_LOGGED_IN/i.test(message)) return 'CODEX_NOT_LOGGED_IN'
  if (/BUNDLED_RUNTIME_NOT_AVAILABLE/i.test(message)) return 'CODEX_BUNDLED_RUNTIME_NOT_AVAILABLE'
  if (/LOGIN/i.test(message)) return message.replace(/[^A-Z0-9_]/gi, '_').slice(0, 80)
  return 'CODEX_RUNTIME_ERROR'
}
