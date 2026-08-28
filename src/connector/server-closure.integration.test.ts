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
      BRAND_PROVIDER: 'remote-codex', CONTENT_PROVIDER: 'remote-codex', MARKET_PROVIDER: 'remote-codex',
      MODERATOR_PROVIDER: 'remote-codex', DIRECTOR_PROVIDER: 'remote-codex',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) {
        const health = await response.json() as any
        expect(health).toMatchObject({ status: 'ok', server: 'ok', database: 'ok', connector: 'ok' })
        return
      }
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
type ConnectorAnswer = string | ((request: any) => string | Promise<string>)

async function pairConnector(cookie: string, name: string, answer: ConnectorAnswer): Promise<TestConnector> {
  const pairing = await json(await api('/api/connectors/claim/start', cookie, { method: 'POST', body: '{}' }))
  const paired = await json(await api('/api/connectors/claim/complete', '', {
    method: 'POST', body: JSON.stringify({
      claim_token: pairing.claim_token,
      device_id: `dev_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      device_name: name,
      platform: 'test',
      connector_version: '0.1.0',
    }),
  }))
  return openConnector(paired.device_credential, name, answer)
}

function openConnector(token: string, name: string, answer: ConnectorAnswer): Promise<TestConnector> {
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
        const started = Date.now()
        void Promise.resolve(typeof answer === 'function' ? answer(message) : answer).then((content) => {
          const finished = Date.now()
          ws.send(JSON.stringify({
            type: 'execution_result', request_id: message.request_id,
            status: 'success', content, usage: { input_tokens: 123, output_tokens: 40 },
            timings: {
              execution_request_at: message.created_at,
              execution_received_at: new Date(started).toISOString(),
              execution_ack_at: new Date(started).toISOString(),
              codex_started_at: new Date(started).toISOString(),
              codex_finished_at: new Date(finished).toISOString(),
              execution_result_at: new Date(finished).toISOString(),
              queue_wait_ms: 2,
              thread_ms: 3,
              codex_execution_ms: Math.max(0, finished - started),
              total_ms: Math.max(5, finished - started + 5),
            },
          }))
        })
      }
    })
    ws.addEventListener('error', () => reject(new Error(`connector ${name} websocket failed`)))
  })
}

async function defaultConversation(cookie: string): Promise<string> {
  const data = await json(await api('/api/conversations', cookie))
  return data.conversations.find((item: any) => item.is_default)?.id
}

async function freeConversation(cookie: string, name: string): Promise<string> {
  const data = await json(await api('/groups', cookie, {
    method: 'POST', body: JSON.stringify({ name, member_ids: ['content'] }),
  }))
  return data.group.id
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
  test('test_existing_credential_reconnects and preserves per-user execution closure', async () => {
    const convA = await freeConversation(userACookie, 'Connector closure A')
    const convB = await freeConversation(userBCookie, 'Connector closure B')
    const connectorA = await pairConnector(userACookie, 'Connector A', 'CONNECTOR_OK_A')
    const connectorB = await pairConnector(userBCookie, 'Connector B', 'CONNECTOR_OK_B')

    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: convA, text: '@content test A', mentions: ['content'] }),
    }))
    await waitForMessage(userACookie, convA, 'CONNECTOR_OK_A')
    expect(connectorA.requests).toHaveLength(1)
    expect(connectorA.requests[0]).toMatchObject({ user_id: userA.id, conversation_id: convA, agent_id: 'content' })
    expect(connectorB.requests).toHaveLength(0)

    await json(await api('/group/send', userBCookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: convB, text: '@content test B', mentions: ['content'] }),
    }))
    await waitForMessage(userBCookie, convB, 'CONNECTOR_OK_B')
    expect(connectorB.requests).toHaveLength(1)
    expect(connectorB.requests[0]).toMatchObject({ user_id: userB.id, conversation_id: convB, agent_id: 'content' })
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
    const convA = await freeConversation(userACookie, 'Connector offline')
    const response = await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: convA, text: '@content offline', mentions: ['content'] }),
    }))
    expect(response.record.delivery.failed).toContain('content')
    expect(response.record.delivery.errors.content).toBe('CODEX_CONNECTOR_OFFLINE')
  })

  test('creative discussion is capped at ten rounds with moderator-selected followups', async () => {
    const conversationId = await defaultConversation(userACookie)
    const connector = await pairConnector(userACookie, 'Creative Discussion Connector', (request) => {
      const prompt = String(request.prompt || '')
      if (request.agent_id === 'moderator' && prompt.includes('第7/10轮')) {
        return '@奇想创意家 与 @市场现实校准员 围绕新鲜感和接受度继续正面讨论。'
      }
      if (request.agent_id === 'moderator' && prompt.includes('第9/10轮')) {
        return '@产品创意策划 与 @内容传播策划 做最后修正，别再扩展新方向。'
      }
      if (request.agent_id === 'director') {
        return 'TOP1 仪式化开箱：兼具记忆和传播；TOP2 可共创IP：能沉淀资产；TOP3 场景化隐藏款：购买理由清晰。保留因差异化与可落地，淘汰同质化且解释成本高的方向。'
      }
      return '@奇想创意家 我支持保留创意核，并补充一条本轮相关的新判断。'
    })

    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: conversationId, text: '为年轻消费者设计一个愿意主动分享的节日礼盒' }),
    }))
    const deadline = Date.now() + 10_000
    let snapshot: any = null
    while (Date.now() < deadline) {
      snapshot = await json(await api(`/api/creative-discussions/current?conversation_id=${encodeURIComponent(conversationId)}`, userACookie))
      if (snapshot.discussion?.status === 'completed') break
      await Bun.sleep(20)
    }
    expect(snapshot?.discussion?.status).toBe('completed')
    expect(snapshot.rounds).toHaveLength(10)
    expect(snapshot.rounds.every((round: any) => round.status === 'completed')).toBe(true)
    expect(snapshot.rounds.every((round: any) => typeof round.duration_ms === 'number')).toBe(true)
    expect(snapshot.rounds.every((round: any) => round.prompt_tokens > 0)).toBe(true)
    expect(snapshot.outputs).toHaveLength(17)
    expect(snapshot.outputs.every((output: any) => output.queue_wait_ms === 2)).toBe(true)
    expect(snapshot.outputs.every((output: any) => typeof output.codex_execution_ms === 'number')).toBe(true)
    expect(snapshot.rounds[6].agents).toEqual(['moderator', 'creative', 'market'])
    expect(snapshot.rounds[8].agents).toEqual(['moderator', 'product', 'content'])
    expect(connector.requests).toHaveLength(17)
    expect(connector.requests.every((request) => String(request.prompt).includes('[最近必要消息]'))).toBe(true)
    expect(connector.requests.every((request) => !String(request.prompt).includes('[当前 Conversation 近期上下文]'))).toBe(true)
    expect(Math.max(...connector.requests.map((request) => String(request.prompt).length))).toBeLessThan(8_000)
    const messages = (await json(await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, userACookie))).messages
    expect(messages.filter((message: any) => message.text.includes('TOP1')).length).toBe(1)
    await connector.close()
  }, 15_000)

  test('persists and exposes each same-round agent result before the round completes', async () => {
    const conversationId = await defaultConversation(userACookie)
    const connector = await pairConnector(userACookie, 'Creative Progressive Connector', async (request) => {
      const prompt = String(request.prompt || '')
      if (request.agent_id === 'brand' && prompt.includes('第2/10轮')) return 'BRAND_FIRST'
      if (request.agent_id === 'product' && prompt.includes('第2/10轮')) {
        await Bun.sleep(250)
        return 'PRODUCT_SECOND'
      }
      if (request.agent_id === 'moderator' && prompt.includes('第7/10轮')) return '@奇想创意家 @市场现实校准员 继续。'
      if (request.agent_id === 'moderator' && prompt.includes('第9/10轮')) return '@产品创意策划 @内容传播策划 修正。'
      if (request.agent_id === 'director') return 'TOP1 A；TOP2 B；TOP3 C。保留差异化，淘汰重复方向。'
      return '本轮补充一个新判断。'
    })

    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: conversationId, text: '验证同轮逐条显示的创意主题' }),
    }))
    const deadline = Date.now() + 5_000
    let observedBeforeRoundCompletion = false
    while (Date.now() < deadline) {
      const messages = (await json(await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, userACookie))).messages
      const snapshot = await json(await api(`/api/creative-discussions/current?conversation_id=${encodeURIComponent(conversationId)}`, userACookie))
      const roundTwo = snapshot.rounds?.find((round: any) => round.round_number === 2)
      if (messages.some((message: any) => message.text === 'BRAND_FIRST') && roundTwo?.pending_agents?.includes('product')) {
        observedBeforeRoundCompletion = true
        break
      }
      await Bun.sleep(10)
    }
    expect(observedBeforeRoundCompletion).toBe(true)

    while (Date.now() < deadline) {
      const snapshot = await json(await api(`/api/creative-discussions/current?conversation_id=${encodeURIComponent(conversationId)}`, userACookie))
      if (snapshot.discussion?.status === 'completed') break
      await Bun.sleep(20)
    }
    await connector.close()
  }, 10_000)
})
