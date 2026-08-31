import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { Subprocess } from 'bun'

const port = 44_000 + Math.floor(Math.random() * 1_000)
const baseUrl = `http://127.0.0.1:${port}`
const tempRoot = mkdtempSync(path.join(tmpdir(), 'ai-studio-profile-auth-'))
let server: Subprocess<'ignore', 'pipe', 'pipe'>
let profiles: Array<{ id: string; display_name: string }> = []
let tina: { id: string; display_name: string }
let liuting: { id: string; display_name: string }
let tinaCookie = ''
let liutingCookie = ''
let tinaConversationId = ''
let liutingConversationId = ''

function spawnServer(): Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(['bun', 'server.ts'], {
    cwd: path.resolve(import.meta.dir, '../..'),
    env: {
      ...process.env,
      AICOLLAB_PORT: String(port),
      AICOLLAB_HOST: '127.0.0.1',
      AICOLLAB_DATA_DIR: path.join(tempRoot, 'runtime-data'),
      AICOLLAB_DATABASE_PATH: path.join(tempRoot, 'data', 'chat.db'),
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
      if ((await fetch(`${baseUrl}/health`)).ok) return
    } catch {}
    await Bun.sleep(50)
  }
  throw new Error('profile auth integration server did not become ready')
}

async function api(pathname: string, cookie = '', init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (cookie) headers.set('cookie', cookie)
  if (init.body) headers.set('content-type', 'application/json')
  return fetch(`${baseUrl}${pathname}`, { ...init, headers, redirect: 'manual' })
}

async function json(response: Response): Promise<any> {
  const value = await response.json()
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`)
  return value
}

function cookieFrom(response: Response): string {
  return response.headers.get('set-cookie')!.split(';', 1)[0]
}

async function selectProfile(profileId: string, remember = false): Promise<{ response: Response; cookie: string }> {
  const response = await api('/api/auth/select-profile', '', {
    method: 'POST',
    body: JSON.stringify({ profile_id: profileId, remember }),
  })
  expect(response.status).toBe(200)
  return { response, cookie: cookieFrom(response) }
}

async function defaultConversation(cookie: string): Promise<string> {
  const data = await json(await api('/api/conversations', cookie))
  return data.conversations.find((item: any) => item.is_default).id
}

function pairingToken(deepLink: string): string {
  return new URL(deepLink).searchParams.get('token') || ''
}

function completionBody(deepLink: string, deviceId: string, deviceName: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    claim_token: pairingToken(deepLink),
    device_id: deviceId,
    device_name: deviceName,
    platform: 'darwin',
    connector_version: '0.1.0',
    ...extra,
  })
}

function openDeviceCredential(deviceCredential: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connector`)
    const timer = setTimeout(() => reject(new Error('device credential authentication timed out')), 5_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      type: 'hello', protocol_version: 1, device_token: deviceCredential, device_name: 'Profile Test Mac',
    })))
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type !== 'hello_ack') return
      clearTimeout(timer)
      if (message.status === 'ok') resolve(ws)
      else reject(new Error(message.error || 'device credential rejected'))
    })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('device websocket failed')) })
  })
}

function waitForSocketClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('device websocket did not close')), 5_000)
    ws.addEventListener('close', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

beforeAll(async () => {
  server = spawnServer()
  await waitForServer()
  profiles = await json(await api('/api/auth/profiles'))
  tina = profiles.find(profile => profile.display_name === 'Tina')!
  liuting = profiles.find(profile => profile.display_name === '刘婷')!
  tinaCookie = (await selectProfile(tina.id)).cookie
  liutingCookie = (await selectProfile(liuting.id)).cookie
  tinaConversationId = await defaultConversation(tinaCookie)
  liutingConversationId = await defaultConversation(liutingCookie)
})

afterAll(async () => {
  try { server.kill('SIGTERM') } catch {}
  try { await server.exited } catch {}
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('Trusted LAN profile authentication', () => {
  test('test_profiles_returns_only_allowed_users', async () => {
    const response = await api('/api/auth/profiles')
    expect(response.status).toBe(200)
    const result = await response.json() as any[]
    expect(result.map(profile => profile.display_name)).toEqual(['文一', 'Tina', '刘婷'])
    expect(result.every(profile => Object.keys(profile).sort().join(',') === 'display_name,id')).toBe(true)
  })

  test('test_select_profile_creates_session', async () => {
    const { response } = await selectProfile(tina.id)
    const setCookie = response.headers.get('set-cookie') || ''
    expect(setCookie).toContain('aicollab_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  test('test_profile_session_resolves_correct_user', async () => {
    const { cookie } = await selectProfile(tina.id)
    const me = await json(await api('/api/auth/me', cookie))
    expect(me.user).toEqual({ id: tina.id, display_name: 'Tina' })
  })

  test('test_tina_cannot_read_liuting_conversation', async () => {
    const conversations = await json(await api('/api/conversations', tinaCookie))
    expect(conversations.conversations.some((item: any) => item.id === liutingConversationId)).toBe(false)
    expect((await api(`/api/conversations/${encodeURIComponent(liutingConversationId)}/messages`, tinaCookie)).status).toBe(404)
  })

  test('test_liuting_cannot_read_tina_messages', async () => {
    const marker = 'TINA_PRIVATE_MESSAGE'
    await json(await api('/group/send', tinaCookie, {
      method: 'POST',
      body: JSON.stringify({ conversation_id: tinaConversationId, text: marker, mentions: [] }),
    }))
    const tinaMessages = await json(await api(`/api/conversations/${encodeURIComponent(tinaConversationId)}/messages`, tinaCookie))
    expect(tinaMessages.messages.some((message: any) => message.text === marker)).toBe(true)
    expect((await api(`/api/conversations/${encodeURIComponent(tinaConversationId)}/messages`, liutingCookie)).status).toBe(404)
    const liutingMessages = await json(await api(`/api/conversations/${encodeURIComponent(liutingConversationId)}/messages`, liutingCookie))
    expect(liutingMessages.messages.some((message: any) => message.text === marker)).toBe(false)
  })

  test('browser cannot forge message user, sender, actor or role', async () => {
    const marker = `D1_ACTOR_${Date.now()}`
    const sent = await json(await api('/group/send', tinaCookie, {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: tinaConversationId,
        text: marker,
        user_id: liuting.id,
        sender_id: 'director',
        sender_actor_id: liuting.id,
        sender_actor_type: 'human',
        owner_user_id: liuting.id,
        execution_owner_user_id: liuting.id,
        role: 'owner',
      }),
    }))
    expect(sent.record.sender_id).toBe('admin')
    expect(sent.record.user_id).toBe(tina.id)
    expect(sent.record.sender_actor_type).toBe('human')
    expect(sent.record.sender_actor_id).toBe(tina.id)
    expect(sent.record.execution_owner_user_id).toBeNull()

    const messages = (await json(await api(`/api/conversations/${encodeURIComponent(tinaConversationId)}/messages`, tinaCookie))).messages
    const saved = messages.find((message: any) => message.text === marker)
    expect(saved).toMatchObject({ sender_id: 'admin', sender_actor_type: 'human', sender_actor_id: tina.id })
  })

  test('profile memory and connector devices remain isolated', async () => {
    await json(await api('/api/agents/social/memory', tinaCookie, {
      method: 'PUT', body: JSON.stringify({ content: 'TINA_PRIVATE_MEMORY' }),
    }))
    expect((await json(await api('/api/agents/social/memory', tinaCookie))).memory.content).toBe('TINA_PRIVATE_MEMORY')
    const liutingMemory = (await json(await api('/api/agents/social/memory', liutingCookie))).memory
    expect(liutingMemory?.content ?? null).not.toBe('TINA_PRIVATE_MEMORY')

    const pairing = await json(await api('/api/connectors/claim/start', tinaCookie, { method: 'POST', body: '{}' }))
    expect(pairing.device_credential).toBeUndefined()
    await json(await api('/api/connectors/claim/complete', '', {
      method: 'POST', body: completionBody(`aistudio://pair?token=${pairing.claim_token}`, 'dev_tina-test-device', 'Tina Test Device'),
    }))
    const tinaDevices = (await json(await api('/api/connectors', tinaCookie))).devices
    const liutingDevices = (await json(await api('/api/connectors', liutingCookie))).devices
    expect(tinaDevices.some((device: any) => device.device_name === 'Tina Test Device')).toBe(true)
    expect(liutingDevices.some((device: any) => device.device_name === 'Tina Test Device')).toBe(false)
  })

  test('test_claim_requires_authenticated_session', async () => {
    expect((await api('/api/connectors/claim/start', '', { method: 'POST', body: '{}' })).status).toBe(401)
  })

  test('test_claim_bound_to_session_user', async () => {
    const pairing = await json(await api('/api/connectors/claim/start', tinaCookie, { method: 'POST', body: '{}' }))
    await json(await api('/api/connectors/claim/complete', '', {
      method: 'POST', body: completionBody(`aistudio://pair?token=${pairing.claim_token}`, 'dev_session-user', 'Session User Mac'),
    }))
    const tinaDevices = (await json(await api('/api/connectors', tinaCookie))).devices
    const liutingDevices = (await json(await api('/api/connectors', liutingCookie))).devices
    expect(tinaDevices.some((device: any) => device.id === 'dev_session-user')).toBe(true)
    expect(liutingDevices.some((device: any) => device.id === 'dev_session-user')).toBe(false)
  })

  test('test_frontend_cannot_override_pairing_user', async () => {
    const pairing = await json(await api('/api/connectors/claim/start', tinaCookie, {
      method: 'POST', body: JSON.stringify({ user_id: liuting.id }),
    }))
    await json(await api('/api/connectors/claim/complete', '', {
      method: 'POST', body: completionBody(`aistudio://pair?token=${pairing.claim_token}`, 'dev_frontend-override', 'Frontend Override Mac'),
    }))
    const tinaDevices = (await json(await api('/api/connectors', tinaCookie))).devices
    const liutingDevices = (await json(await api('/api/connectors', liutingCookie))).devices
    expect(tinaDevices.some((device: any) => device.id === 'dev_frontend-override')).toBe(true)
    expect(liutingDevices.some((device: any) => device.id === 'dev_frontend-override')).toBe(false)
  })

  test('test_connector_cannot_choose_user', async () => {
    const pairing = await json(await api('/api/connectors/claim/start', tinaCookie, { method: 'POST', body: '{}' }))
    const response = await api('/api/connectors/claim/complete', '', {
      method: 'POST',
      body: completionBody(`aistudio://pair?token=${pairing.claim_token}`, 'dev_connector-identity', 'Connector Identity Mac', { user_id: liuting.id }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: 'connector user identity is not accepted' })
  })

  test('test_device_credential_only_sent_to_connector', async () => {
    const pairing = await json(await api('/api/connectors/claim/start', tinaCookie, { method: 'POST', body: '{}' }))
    expect(pairing.claim_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pairing.device_credential).toBeUndefined()
    expect(pairing.device_token).toBeUndefined()
    const deepLink = `aistudio://pair?token=${pairing.claim_token}`
    const browserCompletion = await api('/api/connectors/claim/complete', '', {
      method: 'POST',
      headers: { origin: baseUrl, 'sec-fetch-site': 'same-origin' },
      body: completionBody(deepLink, 'dev_browser-must-not-receive', 'Browser Mac'),
    })
    expect(browserCompletion.status).toBe(403)
    expect(await browserCompletion.json()).toMatchObject({
      code: 'DEVICE_CREDENTIAL_NOT_AVAILABLE_TO_BROWSER',
    })
    const connectorCompletion = await json(await api('/api/connectors/claim/complete', '', {
      method: 'POST',
      body: completionBody(deepLink, 'dev_native-connector', 'Native Connector Mac'),
    }))
    expect(connectorCompletion.device_credential).toBeString()
  })

  test('test_user_a_unbinds_and_user_b_rebinds_same_device', async () => {
    const deviceId = 'dev_profile-transfer'
    const messageMarker = 'UNBIND_MUST_PRESERVE_MESSAGE'
    const memoryMarker = 'UNBIND_MUST_PRESERVE_MEMORY'
    await json(await api('/group/send', tinaCookie, {
      method: 'POST', body: JSON.stringify({ conversation_id: tinaConversationId, text: messageMarker, mentions: [] }),
    }))
    await json(await api('/api/agents/product/memory', tinaCookie, {
      method: 'PUT', body: JSON.stringify({ content: memoryMarker }),
    }))

    const tinaClaim = await json(await api('/api/connectors/claim/start', tinaCookie, { method: 'POST', body: '{}' }))
    const tinaPair = await json(await api('/api/connectors/claim/complete', '', {
      method: 'POST', body: completionBody(`aistudio://pair?token=${tinaClaim.claim_token}`, deviceId, 'Transfer Mac'),
    }))
    const oldSocket = await openDeviceCredential(tinaPair.device_credential)

    expect((await api(`/api/connectors/${deviceId}`, liutingCookie, { method: 'DELETE' })).status).toBe(404)
    const unbound = await json(await api(`/api/connectors/${deviceId}`, tinaCookie, { method: 'DELETE' }))
    expect(unbound).toMatchObject({ ok: true, device_id: deviceId, unbound: true })
    await waitForSocketClose(oldSocket)
    await expect(openDeviceCredential(tinaPair.device_credential)).rejects.toThrow('invalid device token')
    expect((await json(await api('/api/connectors', tinaCookie))).devices.some((device: any) => device.id === deviceId)).toBe(false)

    const liutingClaim = await json(await api('/api/connectors/claim/start', liutingCookie, { method: 'POST', body: '{}' }))
    await json(await api('/api/connectors/claim/complete', '', {
      method: 'POST', body: completionBody(`aistudio://pair?token=${liutingClaim.claim_token}`, deviceId, 'Transfer Mac'),
    }))
    const liutingDevices = (await json(await api('/api/connectors', liutingCookie))).devices
    expect(liutingDevices.some((device: any) => device.id === deviceId && device.user_id === liuting.id)).toBe(true)

    const messages = (await json(await api(`/api/conversations/${encodeURIComponent(tinaConversationId)}/messages`, tinaCookie))).messages
    expect(messages.some((message: any) => message.text === messageMarker)).toBe(true)
    expect((await json(await api('/api/agents/product/memory', tinaCookie))).memory.content).toBe(memoryMarker)
    expect((await json(await api('/api/conversations', tinaCookie))).conversations.some((item: any) => item.id === tinaConversationId)).toBe(true)
  })

  test('test_switch_profile_clears_old_session', async () => {
    const { cookie } = await selectProfile(tina.id)
    expect((await api('/api/auth/me', cookie)).status).toBe(200)
    const logout = await api('/api/auth/logout', cookie, { method: 'POST', body: '{}' })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await api('/api/auth/me', cookie)).status).toBe(401)
  })

  test('test_remember_false_uses_session_cookie', async () => {
    const { response } = await selectProfile(tina.id, false)
    const setCookie = response.headers.get('set-cookie') || ''
    expect(setCookie).not.toContain('Max-Age=')
    expect(setCookie).not.toContain('Expires=')
  })

  test('test_remember_true_uses_persistent_cookie', async () => {
    const { response } = await selectProfile(tina.id, true)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=2592000')
  })

  test('test_profile_cannot_override_user_id_in_api', async () => {
    const marker = 'PROFILE_OVERRIDE_MUST_NOT_WORK'
    await json(await api('/group/send', tinaCookie, {
      method: 'POST',
      body: JSON.stringify({
        user_id: liuting.id,
        conversation_id: tinaConversationId,
        text: marker,
        mentions: [],
      }),
    }))
    const tinaMessages = await json(await api(`/api/conversations/${encodeURIComponent(tinaConversationId)}/messages`, tinaCookie))
    expect(tinaMessages.messages.some((message: any) => message.text === marker)).toBe(true)
    const liutingMessages = await json(await api(`/api/conversations/${encodeURIComponent(liutingConversationId)}/messages`, liutingCookie))
    expect(liutingMessages.messages.some((message: any) => message.text === marker)).toBe(false)
  })
})
