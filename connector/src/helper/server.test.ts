import { afterEach, describe, expect, test } from 'bun:test'
import { LocalHelperServer, type LocalHelperStatus } from './server.ts'

const origin = 'http://192.168.20.200:3998'
const status: LocalHelperStatus = {
  helper: 'online',
  device: { bound: false, device_id: 'dev_tina-mac', device_name: 'Tina MacBook Pro' },
  server: { connected: false },
  platform: 'macos',
  connector_version: '0.1.0',
  codex: { runtime_installed: true, runtime_version: 'codex-cli 1.2.3', logged_in: true, status: 'CODEX_READY' },
}
let helper: LocalHelperServer | null = null

afterEach(() => { helper?.stop(); helper = null })

function startHelper(
  claim: (claimToken: string, requestId: string | null) => Promise<{ bound: boolean; already_bound: boolean }> = async () => ({ bound: true, already_bound: false }),
  codexLogin: () => Promise<{ started: true; status: 'CODEX_AUTHENTICATING' }> = async () => ({ started: true, status: 'CODEX_AUTHENTICATING' }),
  unbind: (deviceId: string) => Promise<{ unbound: true }> = async () => ({ unbound: true }),
) {
  helper = new LocalHelperServer({ port: 0, allowedOrigin: origin, status: () => status, claim, unbind, codexLogin })
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
  let receivedRequestId: string | null = null
  const base = startHelper(async (token, requestId) => {
    received = token
    receivedRequestId = requestId
    return { bound: true, already_bound: false }
  })
  const result = await (await fetch(`${base}/status`, { headers: { origin } })).json() as any
  expect(JSON.stringify(result)).not.toMatch(/credential|device_token|auth_token|refresh_token|session_token/i)
  const claimed = await (await fetch(`${base}/claim`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ claim_token: 'local-claim-token', request_id: 'claim_trace_1' }),
  })).json() as any
  expect(received).toBe('local-claim-token')
  expect(receivedRequestId).toBe('claim_trace_1')
  expect(claimed).toEqual({ ok: true, bound: true, already_bound: false })
  expect(JSON.stringify(claimed)).not.toMatch(/credential|device_token/i)
})

test('test_local_api_only_binds_loopback', () => {
  expect(() => new LocalHelperServer({
    hostname: '0.0.0.0' as any, port: 0, allowedOrigin: origin, status: () => status,
    claim: async () => ({ bound: true, already_bound: false }),
    unbind: async () => ({ unbound: true }),
    codexLogin: async () => ({ started: true, status: 'CODEX_AUTHENTICATING' }),
  }).start()).toThrow('LOCAL_HELPER_MUST_BIND_LOOPBACK')
  const base = startHelper()
  expect(helper!.hostname).toBe('127.0.0.1')
  expect(base).toStartWith('http://127.0.0.1:')
})

test('test_local_helper_unbind_clears_only_current_device', async () => {
  let receivedDeviceId = ''
  const base = startHelper(undefined, undefined, async (deviceId) => {
    receivedDeviceId = deviceId
    return { unbound: true }
  })
  const response = await fetch(`${base}/unbind`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: status.device.device_id }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, unbound: true })
  expect(receivedDeviceId).toBe(status.device.device_id)
})

test('test_codex_login_does_not_expose_auth', async () => {
  const base = startHelper()
  const response = await fetch(`${base}/codex/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
  })
  expect(response.status).toBe(200)
  const result = await response.json() as any
  expect(result).toEqual({ ok: true, started: true, status: 'CODEX_AUTHENTICATING' })
  expect(JSON.stringify(result)).not.toMatch(/authUrl|access_token|refresh_token|cookie|credential/i)
})

test('test_codex_status_ready', async () => {
  const base = startHelper()
  const response = await fetch(`${base}/codex/status`, { headers: { origin } })
  expect(await response.json()).toEqual(status.codex)
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
