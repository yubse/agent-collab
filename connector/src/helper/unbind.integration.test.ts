import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { Subprocess } from 'bun'

const serverPort = 46_000 + Math.floor(Math.random() * 500)
const helperPort = serverPort + 500
const baseUrl = `http://127.0.0.1:${serverPort}`
const helperUrl = `http://127.0.0.1:${helperPort}`
const tempRoot = mkdtempSync(path.join(tmpdir(), 'aistudio-helper-unbind-e2e-'))
const appSupportDir = path.join(tempRoot, 'app-support')
let server: Subprocess<'ignore', 'pipe', 'pipe'>
let helper: Subprocess<'ignore', 'pipe', 'pipe'>

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch {}
    await Bun.sleep(50)
  }
  throw new Error(`service did not become ready: ${url}`)
}

async function selectProfile(displayName: string): Promise<{ id: string; cookie: string }> {
  const profiles = await (await fetch(`${baseUrl}/api/auth/profiles`)).json() as Array<{ id: string; display_name: string }>
  const profile = profiles.find((item) => item.display_name === displayName)!
  const response = await fetch(`${baseUrl}/api/auth/select-profile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile_id: profile.id, remember: false }),
  })
  return { id: profile.id, cookie: response.headers.get('set-cookie')!.split(';', 1)[0] }
}

async function claim(cookie: string): Promise<any> {
  const started = await fetch(`${baseUrl}/api/connectors/claim/start`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  })
  const request = await started.json() as any
  const response = await fetch(`${helperUrl}/claim`, {
    method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ claim_token: request.claim_token, request_id: request.request_id }),
  })
  expect(response.status).toBe(200)
  return response.json()
}

async function devices(cookie: string): Promise<any[]> {
  const result = await (await fetch(`${baseUrl}/api/connectors`, { headers: { cookie } })).json() as any
  return result.devices || []
}

async function waitForOnline(cookie: string, userId: string): Promise<any> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const found = (await devices(cookie)).find((device) => device.user_id === userId && device.status === 'online')
    if (found) return found
    await Bun.sleep(50)
  }
  throw new Error('connector did not become online')
}

beforeAll(async () => {
  const codexHome = path.join(appSupportDir, 'codex-home')
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(path.join(codexHome, 'auth.json'), 'codex-auth-must-remain')
  server = Bun.spawn(['bun', 'server.ts'], {
    cwd: path.resolve(import.meta.dir, '../../..'),
    env: {
      ...process.env, AICOLLAB_PORT: String(serverPort), AICOLLAB_HOST: '127.0.0.1',
      AICOLLAB_DATA_DIR: path.join(tempRoot, 'runtime-data'),
      AICOLLAB_DATABASE_PATH: path.join(tempRoot, 'data', 'chat.db'),
      PRODUCT_PROVIDER: 'remote-codex', CREATIVE_PROVIDER: 'remote-codex',
      SOCIAL_PROVIDER: 'remote-codex', GROWTH_PROVIDER: 'remote-codex',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  await waitFor(`${baseUrl}/health`)
  helper = Bun.spawn(['bun', 'connector/src/index.ts'], {
    cwd: path.resolve(import.meta.dir, '../../..'),
    env: {
      ...process.env,
      AI_STUDIO_SERVER_URL: baseUrl,
      AI_STUDIO_WEB_ORIGIN: baseUrl,
      AI_STUDIO_HELPER_PORT: String(helperPort),
      AI_STUDIO_APP_SUPPORT_DIR: appSupportDir,
      AI_STUDIO_DEVICE_ID: 'dev_helper-transfer',
      USE_SYSTEM_CODEX: '1',
      CODEX_BINARY_PATH: '/usr/bin/false',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  await waitFor(`${helperUrl}/status`)
})

afterAll(async () => {
  try { helper.kill('SIGTERM'); await helper.exited } catch {}
  try { server.kill('SIGTERM'); await server.exited } catch {}
  rmSync(tempRoot, { recursive: true, force: true })
})

test('user A unbinds locally and user B rebinds the same Helper', async () => {
  const userA = await selectProfile('Tina')
  const userB = await selectProfile('刘婷')
  await claim(userA.cookie)
  const deviceA = await waitForOnline(userA.cookie, userA.id)
  expect(deviceA.id).toBe('dev_helper-transfer')

  const credentialPath = path.join(appSupportDir, 'credentials', 'device.json')
  const savedBefore = JSON.parse(readFileSync(credentialPath, 'utf8'))
  expect(savedBefore.device_token).toBeString()

  const serverUnbind = await fetch(`${baseUrl}/api/connectors/${encodeURIComponent(deviceA.id)}`, {
    method: 'DELETE', headers: { cookie: userA.cookie },
  })
  expect(serverUnbind.status).toBe(200)
  const helperUnbind = await fetch(`${helperUrl}/unbind`, {
    method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: deviceA.id }),
  })
  expect(helperUnbind.status).toBe(200)
  const helperStatus = await (await fetch(`${helperUrl}/status`)).json() as any
  expect(helperStatus.device.bound).toBe(false)
  expect(helperStatus.server.connected).toBe(false)
  const savedAfter = JSON.parse(readFileSync(credentialPath, 'utf8'))
  expect(savedAfter.device_id).toBe('dev_helper-transfer')
  expect(savedAfter.device_token).toBeUndefined()
  expect(readFileSync(path.join(appSupportDir, 'codex-home', 'auth.json'), 'utf8')).toBe('codex-auth-must-remain')

  await claim(userB.cookie)
  const deviceB = await waitForOnline(userB.cookie, userB.id)
  expect(deviceB.id).toBe(deviceA.id)
  expect((await devices(userA.cookie)).some((device) => device.id === deviceA.id)).toBe(false)
})
