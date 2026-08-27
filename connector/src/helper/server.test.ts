import { afterEach, describe, expect, test } from 'bun:test'
import { LocalHelperServer, type LocalHelperStatus } from './server.ts'

const origin = 'http://192.168.20.200:3998'
const status: LocalHelperStatus = {
  helper: 'online',
  bound: false,
  server: 'disconnected',
  device_id: 'dev_local-helper',
  device_name: 'Tina MacBook Pro',
  platform: 'macos',
  connector_version: '0.1.0',
  codex: { installed: true, logged_in: true, status: 'CODEX_READY' },
}
let helper: LocalHelperServer | null = null

afterEach(() => { helper?.stop(); helper = null })

function startHelper(claim: (claimToken: string) => Promise<{ bound: boolean; already_bound: boolean }> = async () => ({ bound: true, already_bound: false })) {
  helper = new LocalHelperServer({ port: 0, allowedOrigin: origin, status: () => status, claim })
  helper.start()
  return `http://127.0.0.1:${helper.port}`
}

test('test_local_helper_status', async () => {
  const base = startHelper()
  const response = await fetch(`${base}/status`, { headers: { origin } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(status)
})

test('test_local_helper_does_not_expose_credentials', async () => {
  let received = ''
  const base = startHelper(async (token) => {
    received = token
    return { bound: true, already_bound: false }
  })
  const result = await (await fetch(`${base}/status`, { headers: { origin } })).json() as any
  expect(JSON.stringify(result)).not.toMatch(/credential|device_token|auth_token|refresh_token|session_token/i)
  const claimed = await (await fetch(`${base}/claim`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ claim_token: 'local-claim-token' }),
  })).json() as any
  expect(received).toBe('local-claim-token')
  expect(claimed).toEqual({ ok: true, bound: true, already_bound: false })
  expect(JSON.stringify(claimed)).not.toMatch(/credential|device_token/i)
})

test('test_local_api_only_binds_loopback', () => {
  expect(() => new LocalHelperServer({
    hostname: '0.0.0.0' as any, port: 0, allowedOrigin: origin, status: () => status, claim: async () => ({ bound: true, already_bound: false }),
  }).start()).toThrow('LOCAL_HELPER_MUST_BIND_LOOPBACK')
  const base = startHelper()
  expect(helper!.hostname).toBe('127.0.0.1')
  expect(base).toStartWith('http://127.0.0.1:')
})

test('test_cors_rejects_unknown_origin', async () => {
  const base = startHelper()
  const rejected = await fetch(`${base}/status`, { headers: { origin: 'https://evil.example' } })
  expect(rejected.status).toBe(403)
  expect(rejected.headers.get('access-control-allow-origin')).toBeNull()
  const preflight = await fetch(`${base}/claim`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
  expect(preflight.headers.get('access-control-allow-private-network')).toBe('true')
})
