import { describe, expect, test } from 'bun:test'
import { ConnectorStateStore } from '../state/store.ts'
import { checkCodex } from './preflight.ts'

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
})
