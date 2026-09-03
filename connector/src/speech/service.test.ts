import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { LocalHelperServer } from '../helper/server.ts'
import { cleanupSpeechTemps, SpeechGrantStore, SpeechService } from './service.ts'
import type { TranscriptionProvider } from './provider.ts'
import { ModelManager, sha256File } from './model-manager.ts'

const origin = 'http://nas.test:3998'
const secret = 's'.repeat(43)
const services: SpeechService[] = []
const helpers: LocalHelperServer[] = []
afterEach(() => { for (const service of services.splice(0)) service.stop(); for (const helper of helpers.splice(0)) helper.stop() })

function wavBytes(payloadBytes = 1024) {
  const bytes = new Uint8Array(Math.max(44, payloadBytes))
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode('WAVE'), 8)
  return bytes
}

async function startService(reportProgress: (body: Record<string, unknown>) => Promise<boolean> = async () => true) {
  const appSupportDir = mkdtempSync(path.join(tmpdir(), 'speech-service-'))
  const provider: TranscriptionProvider = {
    name: 'sensevoice',
    async transcribe(request) {
      await request.onStage?.('transcoding', 0.05)
      await request.onStage?.('loading_model', 0.15)
      await request.onStage?.('transcribing', 0.25, { processed_audio_ms: 500, total_audio_ms: 1000, segment_index: 1, segment_count: 2 })
      if (request.signal.aborted) throw new Error('SPEECH_CANCELLED')
      return { transcript: '测试转写', chunks: [{ text: '测试转写', start_ms: null, end_ms: null, speaker: null }], duration_ms: 1000, language: 'zh', provider: 'sensevoice', runtime_version: 'test', model_version: 'test', processing_ms: 1 }
    },
  }
  const service = new SpeechService({ appSupportDir, allowedOrigin: origin, coordinatorSecret: secret, port: 0, provider, reportProgress })
  service.start(); services.push(service)
  return { service, appSupportDir, base: `http://127.0.0.1:${service.port}` }
}

async function issue(base: string, transcriptionId = 'tr_test_123456', userId = 'usr_test_123456', deviceId = 'dev_test_123456') {
  const response = await fetch(`${base}/internal/grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AIStudio-Speech-Secret': secret },
    body: JSON.stringify({ transcription_id: transcriptionId, user_id: userId, device_id: deviceId }),
  })
  return response.json() as Promise<any>
}

async function upload(base: string, token: string, id: string, body = wavBytes(), extra: Record<string, string> = {}) {
  return fetch(`${base}/transcriptions/${id}/audio`, {
    method: 'POST', headers: {
      Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav',
      'X-AIStudio-Original-Name': 'meeting.wav', 'X-AIStudio-Byte-Size': String(body.byteLength), ...extra,
    }, body,
  })
}

describe('M2.2A independent speech service', () => {
  test('starts independently on loopback and reports ready', async () => {
    const { base } = await startService()
    const response = await fetch(`${base}/internal/status`, { headers: { 'X-AIStudio-Speech-Secret': secret } })
    expect(response.status).toBe(200)
    expect((await response.json() as any).status).toBe('ready')
  })

  test('rejects non AI Studio origins and unauthenticated local pages', async () => {
    const { base } = await startService()
    const grant = await issue(base)
    const response = await fetch(`${base}/transcriptions/tr_test_123456/audio`, {
      method: 'POST', headers: { Origin: 'http://evil.test', Authorization: `Bearer ${grant.speech_token}` }, body: wavBytes(),
    })
    expect(response.status).toBe(403)
  })

  test('one-time token is job-bound and rejects replay', async () => {
    const { base } = await startService()
    const wrongJob = await issue(base, 'tr_job_123456')
    expect((await upload(base, wrongJob.speech_token, 'tr_other_123456')).status).toBe(401)
    const grant = await issue(base, 'tr_job_654321')
    expect((await upload(base, grant.speech_token, 'tr_job_654321')).status).toBe(202)
    expect((await upload(base, grant.speech_token, 'tr_job_654321')).status).toBe(401)
  })

  test('token expiration is enforced without logging raw token', () => {
    let now = 1_000
    const store = new SpeechGrantStore(() => now)
    const issued = store.issue({ transcriptionId: 'tr_expire_123456', userId: 'usr_expire_123456', deviceId: 'dev_expire_123456', ttlMs: 10 })
    now += 11
    expect(store.consume(issued.token, 'tr_expire_123456')).toBeNull()
  })

  test('streams to a random temp path and deletes it after completion', async () => {
    const { base, service } = await startService()
    const grant = await issue(base)
    const response = await upload(base, grant.speech_token, 'tr_test_123456', wavBytes(2 * 1024 * 1024))
    expect(response.status).toBe(202)
    expect(readdirSync(service.tmpDir)).toEqual([])
  })

  test('reports queued, saving and completed in order and requires NAS persistence', async () => {
    const stages: string[] = []
    const reports: Record<string, unknown>[] = []
    const { base } = await startService(async (body) => { stages.push(String(body.status)); reports.push(body); return true })
    const grant = await issue(base)
    expect((await upload(base, grant.speech_token, 'tr_test_123456')).status).toBe(202)
    expect(stages.indexOf('queued')).toBeGreaterThan(stages.indexOf('processing'))
    expect(stages.indexOf('saving')).toBeGreaterThan(stages.indexOf('transcribing'))
    expect(stages.at(-1)).toBe('completed')
    expect(reports.find((item) => item.status === 'transcribing')).toMatchObject({ processed_audio_ms: 500, total_audio_ms: 1000, segment_index: 1, segment_count: 2 })
  })

  test('does not claim completed when NAS rejects transcript persistence', async () => {
    const { base, service } = await startService(async (body) => body.status !== 'completed')
    const grant = await issue(base)
    const response = await upload(base, grant.speech_token, 'tr_test_123456')
    expect(response.status).toBe(500)
    expect((await response.json() as any).error).toBe('SPEECH_RESULT_SAVE_FAILED')
    expect(readdirSync(service.tmpDir)).toEqual([])
  })

  test('format mismatch fails and removes temporary data', async () => {
    const { base, service } = await startService()
    const grant = await issue(base)
    const response = await upload(base, grant.speech_token, 'tr_test_123456', new TextEncoder().encode('not wav'))
    expect(response.status).toBe(415)
    expect(readdirSync(service.tmpDir)).toEqual([])
  })

  test('cancel aborts only the active transcription and removes its temp file', async () => {
    const { base, service } = await startService()
    const grant = await issue(base, 'tr_cancel_123456')
    let push: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { push = controller; controller.enqueue(wavBytes(1024)) },
    })
    const uploading = fetch(`${base}/transcriptions/tr_cancel_123456/audio`, {
      method: 'POST', headers: {
        Origin: origin, Authorization: `Bearer ${grant.speech_token}`, 'Content-Type': 'audio/wav',
        'X-AIStudio-Original-Name': 'meeting.wav', 'X-AIStudio-Byte-Size': String(1024 * 1024),
      }, body,
    })
    for (let attempt = 0; attempt < 20 && readdirSync(service.tmpDir).length === 0; attempt++) await Bun.sleep(5)
    const cancelled = await fetch(`${base}/internal/transcriptions/tr_cancel_123456/cancel`, {
      method: 'POST', headers: { 'X-AIStudio-Speech-Secret': secret },
    })
    expect(cancelled.status).toBe(200)
    push!.close()
    expect((await uploading).status).toBe(409)
    expect(readdirSync(service.tmpDir)).toEqual([])
  })

  test('startup cleanup removes only stale speech temp files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'speech-cleanup-'))
    writeFileSync(path.join(dir, 'old.uploading'), 'x')
    writeFileSync(path.join(dir, 'current.processing'), 'x')
    writeFileSync(path.join(dir, 'keep.txt'), 'x')
    utimesSync(path.join(dir, 'old.uploading'), new Date(0), new Date(0))
    expect(cleanupSpeechTemps(dir, Date.now(), 1_000)).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(['current.processing', 'keep.txt'])
  })

  test('speech process failure does not stop Helper local API', async () => {
    const { service } = await startService()
    const helper = new LocalHelperServer({
      port: 0, allowedOrigin: origin,
      status: () => ({ helper: 'online', device: { bound: false, device_id: 'dev_independent', device_name: 'Mac' }, server: { connected: false }, platform: 'macos', connector_version: 'test', codex: { runtime_installed: true, runtime_version: 'test', logged_in: true, status: 'CODEX_READY' } }),
      claim: async () => ({ bound: true, already_bound: false }), unbind: async () => ({ unbound: true }),
      codexLogin: async () => ({ started: true, status: 'CODEX_AUTHENTICATING' }), speechStatus: async () => 'ready',
    })
    helper.start(); helpers.push(helper)
    service.stop()
    const response = await fetch(`http://127.0.0.1:${helper.port}/status`)
    expect(response.status).toBe(200)
    expect((await response.json() as any).codex.status).toBe('CODEX_READY')
    expect((await (await fetch(`http://127.0.0.1:${helper.port}/speech/status`)).json() as any).status).toBe('ready')
  })
})

describe('M2.2A browser streaming source', () => {
  test('uses File.stream and never file.arrayBuffer', async () => {
    const source = await Bun.file(path.join(import.meta.dir, '../../../web/workgroup-v2/speech-upload.js')).text()
    expect(source).toContain('body: file.stream()')
    expect(source).not.toContain('file.arrayBuffer(')
    expect(source).not.toContain('/upload')
  })
})

describe('M2.2B SenseVoice model management', () => {
  test('downloads once, verifies checksum and atomically reuses the model', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'speech-model-'))
    const expectedFile = path.join(dir, 'expected.bin')
    writeFileSync(expectedFile, 'verified model')
    const checksum = await sha256File(expectedFile)
    let downloads = 0
    const manager = new ModelManager(dir, {}, async (_url, destination) => { downloads++; writeFileSync(destination, 'verified model') })
    const artifact = { filename: 'model.gguf', url: 'https://official.test/model', sha256: checksum }
    expect(await manager.ensure(artifact)).toBe(path.join(dir, 'model.gguf'))
    expect(await manager.ensure(artifact)).toBe(path.join(dir, 'model.gguf'))
    expect(downloads).toBe(1)
  })

  test('rejects checksum mismatch and removes partial download', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'speech-model-bad-'))
    const manager = new ModelManager(dir, {}, async (_url, destination) => writeFileSync(destination, 'tampered'))
    await expect(manager.ensure({ filename: 'model.gguf', url: 'https://official.test/model', sha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'SPEECH_MODEL_CHECKSUM_FAILED' })
    expect(readdirSync(dir)).toEqual([])
  })
})
