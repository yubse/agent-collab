import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { Subprocess } from 'bun'

const port = 43_000 + Math.floor(Math.random() * 1_000)
const baseUrl = `http://127.0.0.1:${port}`
const tempRoot = mkdtempSync(path.join(tmpdir(), 'ai-studio-closure-'))
const adminPassword = 'closure-admin-password'
let server: Subprocess<'ignore', 'pipe', 'pipe'>
let adminCookie = ''
let userACookie = ''
let userBCookie = ''
let userA: any
let userB: any

function spawnServer(): Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(['bun', 'server.ts'], {
    cwd: path.resolve(import.meta.dir, '../..'),
    env: {
      ...process.env,
      AICOLLAB_PORT: String(port),
      AICOLLAB_HOST: '127.0.0.1',
      AICOLLAB_DATA_DIR: path.join(tempRoot, 'runtime-data'),
      AICOLLAB_DATABASE_PATH: path.join(tempRoot, 'data', 'chat.db'),
      AICOLLAB_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      PRODUCT_PROVIDER: 'remote-codex', CREATIVE_PROVIDER: 'remote-codex',
      SOCIAL_PROVIDER: 'remote-codex', GROWTH_PROVIDER: 'remote-codex',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`)
      if (response.ok) return
    } catch {}
    await Bun.sleep(50)
  }
  throw new Error('integration server did not become ready')
}

async function api(pathname: string, cookie = '', init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (cookie) headers.set('cookie', cookie)
  if (init.body) headers.set('content-type', 'application/json')
  return fetch(`${baseUrl}${pathname}`, { ...init, headers })
}

async function login(username: string, password: string): Promise<string> {
  const response = await api('/api/auth/login', '', { method: 'POST', body: JSON.stringify({ username, password }) })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')!.split(';', 1)[0]
}

async function json(response: Response): Promise<any> {
  const value = await response.json()
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`)
  return value
}

type TestConnector = { ws: WebSocket; requests: any[]; token: string; close(): Promise<void> }

async function pairConnector(cookie: string, name: string, answer: string): Promise<TestConnector> {
  const pairing = await json(await api('/api/connectors/pairing-code', cookie, { method: 'POST', body: '{}' }))
  const paired = await json(await api('/api/connectors/pair', '', {
    method: 'POST', body: JSON.stringify({ pairing_code: pairing.pairing_code, device_name: name }),
  }))
  return openConnector(paired.device_token, name, answer)
}

function openConnector(token: string, name: string, answer: string): Promise<TestConnector> {
  return new Promise((resolve, reject) => {
    const requests: any[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connector`)
    const timer = setTimeout(() => reject(new Error(`connector ${name} did not authenticate`)), 5_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      type: 'hello', protocol_version: 1, device_token: token, device_name: name,
    })))
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'hello_ack' && message.status === 'ok') {
        clearTimeout(timer)
        resolve({
          ws, requests, token,
          close: () => new Promise<void>((done) => {
            if (ws.readyState === WebSocket.CLOSED) return done()
            ws.addEventListener('close', () => done(), { once: true })
            ws.close()
          }),
        })
      }
      if (message.type === 'execution_request') {
        requests.push(message)
        ws.send(JSON.stringify({
          type: 'execution_ack', request_id: message.request_id,
          status: 'running', acknowledged_at: new Date().toISOString(),
        }))
        ws.send(JSON.stringify({
          type: 'execution_result', request_id: message.request_id,
          status: 'success', content: answer, usage: null,
        }))
      }
    })
    ws.addEventListener('error', () => reject(new Error(`connector ${name} websocket failed`)))
  })
}

async function defaultConversation(cookie: string): Promise<string> {
  const data = await json(await api('/api/conversations', cookie))
  return data.conversations.find((item: any) => item.is_default)?.id
}

async function waitForMessage(cookie: string, conversationId: string, expected: string): Promise<any> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const data = await json(await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, cookie))
    const found = data.messages.find((item: any) => item.text === expected)
    if (found) return found
    await Bun.sleep(25)
  }
  throw new Error(`message ${expected} was not persisted`)
}

beforeAll(async () => {
  server = spawnServer()
  await waitForServer()
  adminCookie = await login('admin', adminPassword)
  userA = (await json(await api('/api/users', adminCookie, {
    method: 'POST', body: JSON.stringify({ username: 'closure_a', display_name: 'User A', password: 'closure-password-a' }),
  }))).user
  userB = (await json(await api('/api/users', adminCookie, {
    method: 'POST', body: JSON.stringify({ username: 'closure_b', display_name: 'User B', password: 'closure-password-b' }),
  }))).user
  userACookie = await login('closure_a', 'closure-password-a')
  userBCookie = await login('closure_b', 'closure-password-b')
})

afterAll(async () => {
  try { server.kill('SIGTERM') } catch {}
  try { await server.exited } catch {}
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('Server → Connector → Conversation closure', () => {
  test('routes each user to their own Connector, persists replies, and survives reconnect', async () => {
    const convA = await defaultConversation(userACookie)
    const convB = await defaultConversation(userBCookie)
    const connectorA = await pairConnector(userACookie, 'Connector A', 'CONNECTOR_OK_A')
    const connectorB = await pairConnector(userBCookie, 'Connector B', 'CONNECTOR_OK_B')

    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: convA, text: '@social test A', mentions: ['social'] }),
    }))
    await waitForMessage(userACookie, convA, 'CONNECTOR_OK_A')
    expect(connectorA.requests).toHaveLength(1)
    expect(connectorA.requests[0]).toMatchObject({ user_id: userA.id, conversation_id: convA, agent_id: 'social' })
    expect(connectorB.requests).toHaveLength(0)

    await json(await api('/group/send', userBCookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: convB, text: '@social test B', mentions: ['social'] }),
    }))
    await waitForMessage(userBCookie, convB, 'CONNECTOR_OK_B')
    expect(connectorB.requests).toHaveLength(1)
    expect(connectorB.requests[0]).toMatchObject({ user_id: userB.id, conversation_id: convB, agent_id: 'social' })
    expect(connectorA.requests).toHaveLength(1)

    expect((await api(`/api/conversations/${encodeURIComponent(convA)}/messages`, userBCookie)).status).toBe(404)
    expect((await api(`/api/conversations/${encodeURIComponent(convB)}/messages`, userACookie)).status).toBe(404)
    expect((await json(await api('/api/connectors', userACookie))).devices.every((item: any) => item.user_id === userA.id)).toBe(true)
    expect((await json(await api('/api/connectors', userBCookie))).devices.every((item: any) => item.user_id === userB.id)).toBe(true)

    await json(await api('/api/agents/social/memory', userACookie, { method: 'PUT', body: JSON.stringify({ content: 'A memory' }) }))
    await json(await api('/api/agents/social/memory', userBCookie, { method: 'PUT', body: JSON.stringify({ content: 'B memory' }) }))
    expect((await json(await api('/api/agents/social/memory', userACookie))).memory.content).toBe('A memory')
    expect((await json(await api('/api/agents/social/memory', userBCookie))).memory.content).toBe('B memory')

    await connectorA.close()
    const restartedA = await openConnector(connectorA.token, 'Connector A restarted', 'CONNECTOR_OK_A_2')
    expect((await json(await api(`/api/conversations/${encodeURIComponent(convA)}/messages`, userACookie))).messages.some((item: any) => item.text === 'CONNECTOR_OK_A')).toBe(true)
    await restartedA.close()
    await connectorB.close()

    // Recreate the Server process against the same bind-mounted paths. This is the
    // local equivalent of a container recreate and proves the database is external.
    server.kill('SIGTERM')
    await server.exited
    server = spawnServer()
    await waitForServer()
    userACookie = await login('closure_a', 'closure-password-a')
    userBCookie = await login('closure_b', 'closure-password-b')
    expect((await json(await api(`/api/conversations/${encodeURIComponent(convA)}/messages`, userACookie))).messages.some((item: any) => item.text === 'CONNECTOR_OK_A')).toBe(true)
  }, 15_000)

  test('returns CODEX_CONNECTOR_OFFLINE immediately without local fallback', async () => {
    const convA = await defaultConversation(userACookie)
    const response = await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: convA, text: '@social offline', mentions: ['social'] }),
    }))
    expect(response.record.delivery.failed).toContain('social')
    expect(response.record.delivery.errors.social).toBe('CODEX_CONNECTOR_OFFLINE')
  })
})
