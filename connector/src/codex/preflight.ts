import type { ConnectorStateStore } from '../state/store.ts'

export class CodexPreflightError extends Error {
  constructor(public code: 'CODEX_NOT_FOUND' | 'CODEX_NOT_LOGGED_IN', message: string) {
    super(message)
    this.name = 'CodexPreflightError'
  }
}

type SpawnSyncLike = (command: string[]) => { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }

const defaultSpawn: SpawnSyncLike = (command) => Bun.spawnSync(command, {
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env },
}) as any

export type CodexPreflightResult = { version: string; login: 'ready' }
export type CodexDetectionResult = {
  installed: boolean
  loggedIn: boolean
  status: 'CODEX_NOT_INSTALLED' | 'CODEX_NOT_LOGGED_IN' | 'CODEX_READY'
  version: string | null
}

export function detectCodexStatus(
  binary: string,
  state: ConnectorStateStore,
  spawnSync: SpawnSyncLike = defaultSpawn,
): CodexDetectionResult {
  let versionResult
  try { versionResult = spawnSync([binary, '--version']) } catch { versionResult = null }
  if (!versionResult || versionResult.exitCode !== 0) {
    state.setCodex('CODEX_RUNTIME_NOT_INSTALLED', 'Codex 运行环境尚未准备。')
    return { installed: false, loggedIn: false, status: 'CODEX_NOT_INSTALLED', version: null }
  }
  const version = new TextDecoder().decode(versionResult.stdout).trim().split(/\r?\n/, 1)[0] || 'unknown'
  let loginResult
  try { loginResult = spawnSync([binary, 'login', 'status']) } catch { loginResult = null }
  if (!loginResult || loginResult.exitCode !== 0) {
    state.setCodex('CODEX_NOT_LOGGED_IN', 'Codex 尚未登录，请先完成本机 Codex 登录。')
    return { installed: true, loggedIn: false, status: 'CODEX_NOT_LOGGED_IN', version }
  }
  state.setCodex('CODEX_READY')
  return { installed: true, loggedIn: true, status: 'CODEX_READY', version }
}

export function checkCodex(
  binary: string,
  state: ConnectorStateStore,
  spawnSync: SpawnSyncLike = defaultSpawn,
): CodexPreflightResult {
  const result = detectCodexStatus(binary, state, spawnSync)
  if (!result.installed) {
    const message = '未找到 Codex CLI，请检查 CODEX_BINARY_PATH。'
    throw new CodexPreflightError('CODEX_NOT_FOUND', message)
  }
  if (!result.loggedIn) {
    const message = 'Codex 尚未登录，请先完成本机 Codex 登录。'
    throw new CodexPreflightError('CODEX_NOT_LOGGED_IN', message)
  }
  return { version: result.version || 'unknown', login: 'ready' }
}
