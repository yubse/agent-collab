import { describe, expect, test } from 'bun:test'
import { ConnectorStateStore } from '../state/store.ts'
import { checkCodex, detectCodexStatus } from './preflight.ts'

const bytes = (value: string) => new TextEncoder().encode(value)

describe('Codex preflight', () => {
  test('checks version before login and reaches CODEX_READY', () => {
    const calls: string[][] = []
    const state = new ConnectorStateStore()
    const result = checkCodex('codex', state, (command) => {
      calls.push(command)
      return { exitCode: 0, stdout: bytes(command.includes('--version') ? 'codex-cli 1.2.3\n' : 'Logged in\n'), stderr: bytes('') }
    })
    expect(calls).toEqual([['codex', '--version'], ['codex', 'login', 'status']])
    expect(result.version).toBe('codex-cli 1.2.3')
    expect(state.snapshot().codex).toBe('CODEX_READY')
  })

  test('uses the required not-logged-in message', () => {
    const state = new ConnectorStateStore()
    expect(() => checkCodex('codex', state, (command) => ({
      exitCode: command.includes('--version') ? 0 : 1,
      stdout: bytes(''),
      stderr: bytes(''),
    }))).toThrow('Codex 尚未登录，请先完成本机 Codex 登录。')
    expect(state.snapshot().codex).toBe('CODEX_NOT_LOGGED_IN')
  })

  test('test_codex_status_detection', () => {
    const missing = detectCodexStatus('codex', new ConnectorStateStore(), () => {
      throw new Error('not found')
    })
    expect(missing).toMatchObject({ installed: false, loggedIn: false, status: 'CODEX_NOT_INSTALLED' })

    const loggedOut = detectCodexStatus('codex', new ConnectorStateStore(), (command) => ({
      exitCode: command.includes('--version') ? 0 : 1,
      stdout: bytes(command.includes('--version') ? 'codex-cli 1.2.3\n' : ''),
      stderr: bytes(''),
    }))
    expect(loggedOut).toMatchObject({ installed: true, loggedIn: false, status: 'CODEX_NOT_LOGGED_IN' })

    const ready = detectCodexStatus('codex', new ConnectorStateStore(), () => ({ exitCode: 0, stdout: bytes('ready\n'), stderr: bytes('') }))
    expect(ready).toMatchObject({ installed: true, loggedIn: true, status: 'CODEX_READY' })
  })
})
