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

type TestConnector = { ws: WebSocket; requests: any[]; cancellations: any[]; token: string; close(): Promise<void> }
type ConnectorAnswerValue = string | { error: string }
type ConnectorAnswer = ConnectorAnswerValue | ((request: any) => ConnectorAnswerValue | Promise<ConnectorAnswerValue>)

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
    const cancellations: any[] = []
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
          ws, requests, cancellations, token,
          close: () => new Promise<void>((done) => {
            if (ws.readyState === WebSocket.CLOSED) return done()
            ws.addEventListener('close', () => done(), { once: true })
            ws.close()
          }),
        })
      }
      if (message.type === 'cancel_request') cancellations.push(message)
      if (message.type === 'execution_request') {
        requests.push(message)
        ws.send(JSON.stringify({
          type: 'execution_ack', request_id: message.request_id,
          status: 'running', acknowledged_at: new Date().toISOString(),
        }))
        const started = Date.now()
        void Promise.resolve(typeof answer === 'function' ? answer(message) : answer).then((content) => {
          const finished = Date.now()
          if (typeof content !== 'string') {
            ws.send(JSON.stringify({
              type: 'execution_result', request_id: message.request_id,
              status: 'error', error: content.error,
              timings: {
                execution_request_at: message.created_at,
                execution_received_at: new Date(started).toISOString(),
                execution_ack_at: new Date(started).toISOString(),
                codex_started_at: new Date(started).toISOString(),
                codex_finished_at: new Date(finished).toISOString(),
                execution_result_at: new Date(finished).toISOString(),
                queue_wait_ms: 0, thread_ms: 0,
                codex_execution_ms: Math.max(0, finished - started),
                total_ms: Math.max(0, finished - started),
              },
            }))
            return
          }
          ws.send(JSON.stringify({
            type: 'execution_delta', request_id: message.request_id,
            sequence: 1, delta: content, created_at: new Date(finished).toISOString(),
          }))
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

async function waitForThreadMessage(cookie: string, threadId: string, expected: string): Promise<any> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const data = await json(await api(`/api/threads/${encodeURIComponent(threadId)}/messages`, cookie))
    const found = data.messages.find((item: any) => item.text === expected)
    if (found) return found
    await Bun.sleep(25)
  }
  throw new Error(`thread message ${expected} was not persisted`)
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
  test('D3 Channel Thread inherits membership, routes Agent execution and isolates context/streaming', async () => {
    const privateMarker = `D3_PRIVATE_MEMORY_${Date.now()}`
    await json(await api('/api/agents/content/memory', userACookie, {
      method: 'PUT', body: JSON.stringify({ content: privateMarker }),
    }))
    const created = await json(await api('/api/channels', userACookie, {
      method: 'POST', body: JSON.stringify({
        name: 'D3 Shared', human_member_ids: [userB.id], agent_member_ids: ['content'],
      }),
    }))
    const channelId = created.channel.id
    const rootSent = await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: channelId, text: 'D3 root packaging direction' }),
    }))
    const rootId = rootSent.record.id
    const first = await api(`/api/channels/${channelId}/threads`, userACookie, {
      method: 'POST', body: JSON.stringify({ root_message_id: rootId, created_by_actor_id: userB.id }),
    })
    expect(first.status).toBe(201)
    const thread = (await json(first)).thread
    const duplicate = await json(await api(`/api/channels/${channelId}/threads`, userBCookie, {
      method: 'POST', body: JSON.stringify({ root_message_id: rootId }),
    }))
    expect(duplicate.thread.id).toBe(thread.id)
    expect(thread.created_by_actor_id).toBe(userA.id)

    const humanA = await json(await api(`/api/threads/${thread.id}/messages`, userACookie, {
      method: 'POST', body: JSON.stringify({ text: 'A says drawer box', user_id: userB.id, thread_id: 'forged' }),
    }))
    const humanB = await json(await api(`/api/threads/${thread.id}/messages`, userBCookie, {
      method: 'POST', body: JSON.stringify({ text: 'B says cost is high' }),
    }))
    expect(humanA.record.sender_actor_id).toBe(userA.id)
    expect(humanA.record.thread_id).toBe(thread.id)
    expect(humanB.record.sender_actor_id).toBe(userB.id)
    const historyA = await json(await api(`/api/threads/${thread.id}/messages`, userACookie))
    const historyB = await json(await api(`/api/threads/${thread.id}/messages`, userBCookie))
    expect(historyA.messages.map((m: any) => m.id)).toEqual(historyB.messages.map((m: any) => m.id))

    const connectorA = await pairConnector(userACookie, 'D3 Connector A', async (request) => {
      if (String(request.prompt).includes('D3_CANCEL')) { await Bun.sleep(300); return 'D3_LATE_RESULT' }
      await Bun.sleep(40); return 'D3_AGENT_REPLY'
    })
    await json(await api(`/api/threads/${thread.id}/messages`, userACookie, {
      method: 'POST', body: JSON.stringify({ text: '@content propose an option', mentions: ['content'] }),
    }))
    const agentReply = await waitForThreadMessage(userBCookie, thread.id, 'D3_AGENT_REPLY')
    expect(agentReply).toMatchObject({ thread_id: thread.id, execution_owner_user_id: userA.id })
    expect(connectorA.requests).toHaveLength(1)
    expect(connectorA.requests[0]).toMatchObject({ user_id: userA.id, conversation_id: channelId, agent_id: 'content' })
    const prompt = String(connectorA.requests[0].prompt)
    expect(prompt).toContain('[Thread 原始消息]')
    expect(prompt).toContain('D3 root packaging direction')
    expect(prompt).toContain('[当前 Thread 近期上下文]')
    expect(prompt).not.toContain('[当前 Conversation 近期上下文]')
    expect(prompt).not.toContain(privateMarker)

    const main = await json(await api(`/api/conversations/${channelId}/messages`, userACookie))
    expect(main.messages.some((message: any) => message.id === agentReply.id)).toBe(false)
    const refreshedRoot = main.messages.find((message: any) => message.id === rootId)
    expect(refreshedRoot.thread_summary).toMatchObject({ id: thread.id, reply_count: 4 })
    const mainStream = await json(await api(`/group/poll?conversation_id=${channelId}&stream_since=0`, userACookie))
    const threadStreamA = await json(await api(`/group/poll?conversation_id=${channelId}&thread_id=${thread.id}&stream_since=0`, userACookie))
    const threadStreamB = await json(await api(`/group/poll?conversation_id=${channelId}&thread_id=${thread.id}&stream_since=0`, userBCookie))
    expect(mainStream.execution_events.some((event: any) => event.message_id === agentReply.id)).toBe(false)
    const normalized = (stream: any) => stream.execution_events.map((event: any) => [event.type, event.message_id, event.thread_id])
    expect(normalized(threadStreamA)).toEqual(normalized(threadStreamB))
    expect(threadStreamA.execution_events.some((event: any) => event.type === 'execution_delta' && event.message_id === agentReply.id)).toBe(true)
    expect(threadStreamA.execution_events.filter((event: any) => event.type === 'execution_result' && event.message_id === agentReply.id)).toHaveLength(1)

    await json(await api(`/api/threads/${thread.id}/messages`, userACookie, {
      method: 'POST', body: JSON.stringify({ text: '@content D3_CANCEL', mentions: ['content'] }),
    }))
    while (connectorA.requests.length < 2) await Bun.sleep(5)
    const stopped = await json(await api('/group/stop', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: channelId, thread_id: thread.id }),
    }))
    expect(stopped).toMatchObject({ stopped: true, thread_id: thread.id })
    expect(connectorA.cancellations).toHaveLength(1)
    await Bun.sleep(350)
    const afterStop = await json(await api(`/api/threads/${thread.id}/messages`, userACookie))
    expect(afterStop.messages.some((message: any) => message.text === 'D3_LATE_RESULT')).toBe(false)
    expect(afterStop.messages.some((message: any) => message.text === '已停止')).toBe(true)

    expect((await api(`/api/threads/${thread.id}`, adminCookie)).status).toBe(404)
    expect((await api(`/api/threads/${thread.id}/messages`, adminCookie)).status).toBe(404)
    await json(await api(`/api/channels/${channelId}/members/human/${userB.id}`, userACookie, { method: 'DELETE' }))
    expect((await api(`/api/threads/${thread.id}`, userBCookie)).status).toBe(404)
    expect((await api(`/api/threads/${thread.id}/messages`, userBCookie)).status).toBe(404)
    expect((await api(`/group/poll?conversation_id=${channelId}&thread_id=${thread.id}`, userBCookie)).status).toBe(404)
    await connectorA.close()
  }, 15_000)

  test('D2 shared Channel isolates execution ownership and broadcasts one message stream', async () => {
    const privateMarker = `PRIVATE_MEMORY_${Date.now()}`
    await json(await api('/api/agents/content/memory', userACookie, {
      method: 'PUT', body: JSON.stringify({ content: privateMarker }),
    }))
    const created = await json(await api('/api/channels', userACookie, {
      method: 'POST',
      body: JSON.stringify({
        name: 'D2 Shared', human_member_ids: [userB.id], agent_member_ids: ['content'],
        user_id: userB.id, owner_user_id: userB.id, role: 'owner',
      }),
    }))
    const channelId = created.channel.id
    expect(created.channel.scope).toBe('shared')
    expect(created.channel.owner_user_id).toBe(userA.id)
    expect(created.channel.memberships.find((m: any) => m.member_id === userA.id).role).toBe('owner')
    expect(created.channel.memberships.find((m: any) => m.member_id === userB.id).role).toBe('member')

    const connectorA = await pairConnector(userACookie, 'D2 Connector A', async (request) => {
      if (String(request.prompt).includes('D2_CANCEL_A')) { await Bun.sleep(300); return 'D2_LATE_A' }
      await Bun.sleep(60); return 'D2_AGENT_A'
    })
    const connectorB = await pairConnector(userBCookie, 'D2 Connector B', async (request) => {
      if (String(request.prompt).includes('D2_CANCEL_B')) { await Bun.sleep(300); return 'D2_LATE_B' }
      await Bun.sleep(60); return 'D2_AGENT_B'
    })

    const humanA = `D2_HUMAN_A_${Date.now()}`
    const humanSent = await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: channelId, text: humanA, mentions: [] }),
    }))
    expect(humanSent.targets).toEqual([])
    expect(humanSent.observers).toEqual([])
    const bHistory = await json(await api(`/api/conversations/${channelId}/messages`, userBCookie))
    const humanMessage = bHistory.messages.find((m: any) => m.text === humanA)
    expect(humanMessage.sender_actor).toMatchObject({ type: 'human', id: userA.id, display_name: 'User A' })
    const bRealtime = await json(await api(`/group/poll?conversation_id=${channelId}&stream_since=0`, userBCookie))
    expect(bRealtime.execution_events.some((e: any) => e.type === 'message_created' && e.message_id === humanMessage.id)).toBe(true)

    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: channelId, text: '@content from A', mentions: ['content'] }),
    }))
    await json(await api('/group/send', userBCookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: channelId, text: '@content from B', mentions: ['content'] }),
    }))
    const [agentA, agentB] = await Promise.all([
      waitForMessage(userACookie, channelId, 'D2_AGENT_A'),
      waitForMessage(userBCookie, channelId, 'D2_AGENT_B'),
    ])
    expect(agentA.execution_owner_user_id).toBe(userA.id)
    expect(agentB.execution_owner_user_id).toBe(userB.id)
    expect(agentA.sender_actor).toMatchObject({ type: 'agent', id: 'content' })
    expect(connectorA.requests).toHaveLength(1)
    expect(connectorB.requests).toHaveLength(1)
    expect(connectorA.requests[0]).toMatchObject({ user_id: userA.id, conversation_id: channelId, agent_id: 'content' })
    expect(connectorB.requests[0]).toMatchObject({ user_id: userB.id, conversation_id: channelId, agent_id: 'content' })
    expect(String(connectorA.requests[0].prompt)).not.toContain(privateMarker)

    const streamA = await json(await api(`/group/poll?conversation_id=${channelId}&stream_since=0`, userACookie))
    const streamB = await json(await api(`/group/poll?conversation_id=${channelId}&stream_since=0`, userBCookie))
    const normalized = (stream: any) => stream.execution_events
      .filter((e: any) => ['execution_delta', 'execution_result'].includes(e.type))
      .map((e: any) => [e.type, e.message_id, e.sequence || null])
    expect(normalized(streamA)).toEqual(normalized(streamB))
    expect(new Set([agentA.id, agentB.id]).size).toBe(2)

    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: channelId, text: '@content D2_CANCEL_A', mentions: ['content'] }),
    }))
    while (connectorA.requests.length < 2) await Bun.sleep(5)
    const memberStop = await json(await api('/group/stop', userBCookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: channelId }),
    }))
    expect(memberStop.stopped).toBe(false)
    expect(connectorA.cancellations).toHaveLength(0)
    await json(await api('/group/stop', userACookie, { method: 'POST', body: JSON.stringify({ conversation_id: channelId }) }))
    expect(connectorA.cancellations).toHaveLength(1)

    await json(await api('/group/send', userBCookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: channelId, text: '@content D2_CANCEL_B', mentions: ['content'] }),
    }))
    while (connectorB.requests.length < 2) await Bun.sleep(5)
    await json(await api('/group/stop', userACookie, { method: 'POST', body: JSON.stringify({ conversation_id: channelId }) }))
    expect(connectorB.cancellations).toHaveLength(1)

    expect((await api(`/api/conversations/${channelId}/messages`, adminCookie)).status).toBe(404)
    expect((await api('/group/send', adminCookie, { method: 'POST', body: JSON.stringify({ conversation_id: channelId, text: 'forged' }) })).status).toBe(400)
    expect((await api(`/group/poll?conversation_id=${channelId}`, adminCookie)).status).toBe(404)
    expect((await api(`/api/search?channels=${channelId}&q=D2`, adminCookie)).status).toBe(403)

    const uploaded = await json(await api('/upload?name=d2.txt', userBCookie, { method: 'POST', body: 'D2 attachment' }))
    await json(await api('/group/send', userBCookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: channelId, text: 'D2 attachment', files: [uploaded.filename], mentions: [] }),
    }))
    expect((await api(`/images/${uploaded.filename}`, userACookie)).status).toBe(200)

    const removed = await api(`/api/channels/${channelId}/members/human/${userB.id}`, userACookie, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await api(`/api/conversations/${channelId}/messages`, userBCookie)).status).toBe(404)
    expect((await api(`/group/poll?conversation_id=${channelId}`, userBCookie)).status).toBe(404)
    expect((await api(`/api/search?channels=${channelId}&q=D2`, userBCookie)).status).toBe(403)
    expect((await api(`/group/stream?conversation_id=${channelId}`, userBCookie)).status).toBe(404)
    expect((await api(`/images/${uploaded.filename}`, userBCookie)).status).toBe(404)
    expect((await api('/seen', userBCookie, { method: 'POST', body: JSON.stringify({ channel: channelId, last_seen_id: humanMessage.id }) })).status).toBe(404)
    await connectorA.close()
    await connectorB.close()
  }, 15_000)

  test('test_existing_credential_reconnects and preserves per-user execution closure', async () => {
    const convA = await freeConversation(userACookie, 'Connector closure A')
    const convB = await freeConversation(userBCookie, 'Connector closure B')
    const connectorA = await pairConnector(userACookie, 'Connector A', 'CONNECTOR_OK_A')
    const connectorB = await pairConnector(userBCookie, 'Connector B', 'CONNECTOR_OK_B')

    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: convA, text: '@content test A', mentions: ['content'] }),
    }))
    await waitForMessage(userACookie, convA, 'CONNECTOR_OK_A')
    const streamA = await json(await api(`/group/poll?conversation_id=${encodeURIComponent(convA)}&stream_since=0`, userACookie))
    const streamTypes = streamA.execution_events.map((event: any) => event.type)
    expect(streamTypes).toContain('execution_delta')
    expect(streamTypes.indexOf('execution_delta')).toBeLessThan(streamTypes.indexOf('execution_result'))
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

  test('closes the browser execution when a Connector Codex turn fails', async () => {
    const conversationId = await freeConversation(userACookie, 'Connector execution failure')
    const connector = await pairConnector(userACookie, 'Failing Connector', { error: 'CODEX_EXECUTION_ERROR' })
    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({
        conversation_id: conversationId, text: '@content fail visibly', mentions: ['content'],
      }),
    }))
    const deadline = Date.now() + 2_000
    let stream: any = null
    while (Date.now() < deadline) {
      stream = await json(await api(
        `/group/poll?conversation_id=${encodeURIComponent(conversationId)}&stream_since=0`, userACookie,
      ))
      if (stream.execution_events.some((item: any) => item.type === 'execution_error')) break
      await Bun.sleep(10)
    }
    const started = stream.execution_events.find((item: any) => item.type === 'execution_started')
    expect(started).toBeTruthy()
    expect(stream.execution_events).toContainEqual(expect.objectContaining({
      type: 'execution_error',
      message_id: started.message_id,
      status: 'error',
      error: 'CODEX_EXECUTION_ERROR',
    }))
    expect(stream.execution_events.filter((item: any) =>
      item.type === 'execution_result' && item.message_id === started.message_id)).toHaveLength(0)
    expect(connector.ws.readyState).toBe(WebSocket.OPEN)
    await connector.close()
  })

  test('stops one conversation by request_id and ignores late connector output', async () => {
    const stoppedConversation = await freeConversation(userACookie, 'Precise stop')
    const unaffectedConversation = await freeConversation(userACookie, 'Unaffected run')
    const connector = await pairConnector(userACookie, 'Precise Stop Connector', async (request) => {
      if (request.conversation_id === stoppedConversation) {
        await Bun.sleep(300)
        return 'LATE_CANCELLED_RESULT'
      }
      return 'OTHER_CONVERSATION_OK'
    })

    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({
        conversation_id: stoppedConversation, text: '@content stop this run', mentions: ['content'],
      }),
    }))
    const requestDeadline = Date.now() + 2_000
    while (!connector.requests.some((item) => item.conversation_id === stoppedConversation) && Date.now() < requestDeadline) {
      await Bun.sleep(10)
    }
    const stoppedRequest = connector.requests.find((item) => item.conversation_id === stoppedConversation)
    expect(stoppedRequest).toBeTruthy()

    await json(await api('/group/send', userACookie, {
      method: 'POST', body: JSON.stringify({
        conversation_id: unaffectedConversation, text: '@content keep this run', mentions: ['content'],
      }),
    }))
    const stopResponse = await json(await api('/group/stop', userACookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: stoppedConversation }),
    }))
    expect(stopResponse).toMatchObject({ ok: true, status: 'stopped', stopped: true })
    expect(connector.cancellations).toContainEqual(expect.objectContaining({
      type: 'cancel_request', request_id: stoppedRequest.request_id, reason: 'user_cancel',
    }))

    await waitForMessage(userACookie, unaffectedConversation, 'OTHER_CONVERSATION_OK')
    await Bun.sleep(350)
    const stoppedMessages = (await json(await api(
      `/api/conversations/${encodeURIComponent(stoppedConversation)}/messages`, userACookie,
    ))).messages
    expect(stoppedMessages.some((item: any) => item.text === 'LATE_CANCELLED_RESULT')).toBe(false)
    expect(stoppedMessages.some((item: any) => item.text === '已停止')).toBe(true)
    const stream = await json(await api(
      `/group/poll?conversation_id=${encodeURIComponent(stoppedConversation)}&stream_since=0`, userACookie,
    ))
    expect(stream.execution_events.some((item: any) =>
      item.type === 'execution_error' && item.error === 'CODEX_EXECUTION_CANCELLED')).toBe(true)
    expect(connector.ws.readyState).toBe(WebSocket.OPEN)
    await connector.close()
  }, 10_000)

  test('creative discussion is capped at seven rounds with moderator-selected followups', async () => {
    const conversationId = await defaultConversation(userACookie)
    const connector = await pairConnector(userACookie, 'Creative Discussion Connector', (request) => {
      const prompt = String(request.prompt || '')
      if (request.agent_id === 'moderator' && prompt.includes('第3/7轮')) {
        return '@创想家A 与 @创想家D 围绕视觉新鲜感和体验成本继续正面讨论。'
      }
      if (request.agent_id === 'director') {
        return 'TOP1 仪式化开箱：兼具记忆和传播；TOP2 可共创IP：能沉淀资产；TOP3 场景化隐藏款：购买理由清晰。保留因差异化与可落地，淘汰同质化且解释成本高的方向。'
      }
      return '@创想家A 我支持保留创意核，并补充一条本轮相关的新判断。'
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
    expect(snapshot.rounds).toHaveLength(7)
    expect(snapshot.rounds.every((round: any) => round.status === 'completed')).toBe(true)
    expect(snapshot.rounds.every((round: any) => typeof round.duration_ms === 'number')).toBe(true)
    expect(snapshot.rounds.every((round: any) => round.prompt_tokens > 0)).toBe(true)
    expect(snapshot.outputs).toHaveLength(18)
    expect(snapshot.outputs.every((output: any) => output.queue_wait_ms === 2)).toBe(true)
    expect(snapshot.outputs.every((output: any) => typeof output.codex_execution_ms === 'number')).toBe(true)
    expect(snapshot.outputs.every((output: any) => output.prompt_tokens === 123)).toBe(true)
    expect(snapshot.outputs.filter((output: any) => ['creative', 'brand', 'product', 'content', 'moderator'].includes(output.agent_id))
      .every((output: any) => output.model === 'gpt-5.6-luna' && output.reasoning_effort === 'low')).toBe(true)
    expect(snapshot.outputs.filter((output: any) => output.agent_id === 'market')
      .every((output: any) => output.model === 'gpt-5.6-terra' && output.reasoning_effort === 'low')).toBe(true)
    expect(snapshot.outputs.filter((output: any) => output.agent_id === 'director')
      .every((output: any) => output.model === 'gpt-5.6-terra' && output.reasoning_effort === 'medium')).toBe(true)
    expect(snapshot.rounds[0].agents).toEqual(['creative', 'brand', 'product', 'content'])
    expect(snapshot.rounds[2].agents).toEqual(['moderator', 'creative', 'content'])
    expect(connector.requests).toHaveLength(18)
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
      if (request.agent_id === 'creative' && prompt.includes('第1/7轮')) return 'CREATOR_A_FIRST'
      if (request.agent_id === 'content' && prompt.includes('第1/7轮')) {
        await Bun.sleep(250)
        return 'CREATOR_D_SECOND'
      }
      if (request.agent_id === 'moderator' && prompt.includes('第3/7轮')) return '@创想家A @创想家D 继续。'
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
      const roundOne = snapshot.rounds?.find((round: any) => round.round_number === 1)
      if (messages.some((message: any) => message.text === 'CREATOR_A_FIRST') && roundOne?.pending_agents?.includes('content')) {
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
