import type { ConnectorStateStore } from '../state/store.ts'

export class CodexPreflightError extends Error {
  constructor(public code: 'CODEX_NOT_FOUND' | 'CODEX_NOT_LOGGED_IN', message: string) {
    super(message)
    this.name = 'CodexPreflightError'
  }
}

type SpawnSyncLike = (command: string[]) => { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }

const defaultSpawn: SpawnSyncLike = (command) => Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' }) as any

export type CodexPreflightResult = { version: string; login: 'ready' }

export function checkCodex(
  binary: string,
  state: ConnectorStateStore,
  spawnSync: SpawnSyncLike = defaultSpawn,
): CodexPreflightResult {
  let versionResult
  try {
    versionResult = spawnSync([binary, '--version'])
  } catch {
    const message = '未找到 Codex CLI，请先在本机安装 Codex。'
    state.setCodex('CODEX_NOT_FOUND', message)
    throw new CodexPreflightError('CODEX_NOT_FOUND', message)
  }
  if (versionResult.exitCode !== 0) {
    const message = '未找到 Codex CLI，请检查 CODEX_BINARY_PATH。'
    state.setCodex('CODEX_NOT_FOUND', message)
    throw new CodexPreflightError('CODEX_NOT_FOUND', message)
  }
  const version = new TextDecoder().decode(versionResult.stdout).trim().split(/\r?\n/, 1)[0] || 'unknown'

  let loginResult
  try {
    loginResult = spawnSync([binary, 'login', 'status'])
  } catch {
    const message = 'Codex 尚未登录，请先完成本机 Codex 登录。'
    state.setCodex('CODEX_NOT_LOGGED_IN', message)
    throw new CodexPreflightError('CODEX_NOT_LOGGED_IN', message)
  }
  if (loginResult.exitCode !== 0) {
    const message = 'Codex 尚未登录，请先完成本机 Codex 登录。'
    state.setCodex('CODEX_NOT_LOGGED_IN', message)
    throw new CodexPreflightError('CODEX_NOT_LOGGED_IN', message)
  }

  state.setCodex('CODEX_READY')
  return { version, login: 'ready' }
}
