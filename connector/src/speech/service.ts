import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, renameSync } from 'fs'
import { open, rename, unlink } from 'fs/promises'
import path from 'path'
import { detectAudioSignature } from '../../../src/assets/storage.ts'
import { AudioPipeline } from './audio-pipeline.ts'
import { ModelManager } from './model-manager.ts'
import { SpeechProviderError, type TranscriptionProvider, type TranscriptionResult } from './provider.ts'
import { defaultSenseVoiceRuntime, SenseVoiceProvider } from './sensevoice-provider.ts'
import { SENSEVOICE_MODEL, SENSEVOICE_RUNTIME } from './runtime-manifest.ts'

export const SPEECH_SERVICE_PORT = 39482
export const SPEECH_TOKEN_TTL_MS = 3 * 60_000
export const SPEECH_TMP_MAX_AGE_MS = 24 * 60 * 60_000
export const SPEECH_MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024

type SpeechGrant = {
  tokenHash: string
  transcriptionId: string
  userId: string
  deviceId: string
  expiresAt: number
  usedAt: number | null
}

type ActiveJob = { controller: AbortController; temporaryPath: string; processingPath: string }

export type SpeechServiceOptions = {
  appSupportDir: string
  allowedOrigin: string
  coordinatorSecret: string
  helperUrl?: string
  hostname?: '127.0.0.1'
  port?: number
  now?: () => number
  provider?: TranscriptionProvider
  downloadEnv?: Record<string, string>
  reportProgress?: (body: Record<string, unknown>) => Promise<boolean>
}

export class SpeechGrantStore {
  private grants = new Map<string, SpeechGrant>()
  constructor(private readonly now = () => Date.now()) {}

  issue(input: { transcriptionId: string; userId: string; deviceId: string; ttlMs?: number }) {
    this.sweep()
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(token)
    const expiresAt = this.now() + Math.min(Math.max(input.ttlMs || SPEECH_TOKEN_TTL_MS, 1), 5 * 60_000)
    this.grants.set(tokenHash, { tokenHash, ...input, expiresAt, usedAt: null })
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }

  consume(token: string, transcriptionId: string): SpeechGrant | null {
    this.sweep()
    const tokenHash = hashToken(token)
    const grant = this.grants.get(tokenHash)
    if (!grant || grant.usedAt !== null || grant.expiresAt <= this.now() || grant.transcriptionId !== transcriptionId) return null
    grant.usedAt = this.now()
    return { ...grant }
  }

  sweep() {
    const now = this.now()
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now || grant.usedAt !== null) this.grants.delete(key)
    }
  }
}

export class SpeechService {
  private server: ReturnType<typeof Bun.serve> | null = null
  private state: 'ready' | 'busy' | 'error' = 'ready'
  private readonly grants: SpeechGrantStore
  private readonly jobs = new Map<string, ActiveJob>()
  private readonly progressChannels = new Map<string, {
    running: Promise<void> | null
    latest: (() => Promise<boolean>) | null
  }>()
  private readonly provider: TranscriptionProvider
  readonly tmpDir: string
  readonly logPath: string

  constructor(private readonly options: SpeechServiceOptions) {
    this.grants = new SpeechGrantStore(options.now)
    this.tmpDir = path.join(options.appSupportDir, 'speech', 'tmp')
    const logDir = path.join(options.appSupportDir, 'logs')
    mkdirSync(logDir, { recursive: true, mode: 0o700 })
    this.logPath = path.join(logDir, 'speech-service.log')
    try { chmodSync(this.logPath, 0o600) } catch {}
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 })
    chmodSync(this.tmpDir, 0o700)
    cleanupSpeechTemps(this.tmpDir, options.now?.() || Date.now())
    this.provider = options.provider || new SenseVoiceProvider({
      runtimePath: defaultSenseVoiceRuntime(options.appSupportDir),
      modelManager: new ModelManager(path.join(options.appSupportDir, 'speech', 'models'), options.downloadEnv),
      audioPipeline: new AudioPipeline(this.tmpDir, '/usr/bin/afconvert', (stage, fields) => this.log(stage, fields)),
      diagnostic: (stage, fields) => this.log(stage, fields),
    })
  }

  start() {
    if (this.server) return
    const hostname = this.options.hostname || '127.0.0.1'
    if (hostname !== '127.0.0.1') throw new Error('SPEECH_SERVICE_MUST_BIND_LOOPBACK')
    this.server = Bun.serve({ hostname, port: this.options.port ?? SPEECH_SERVICE_PORT, fetch: (request) => this.handle(request) })
    this.log('service_ready', { version: process.env.AI_STUDIO_VERSION || 'dev', commit: process.env.AI_STUDIO_COMMIT || 'unknown', runtime_version: SENSEVOICE_RUNTIME.version, model_checksum: SENSEVOICE_MODEL.sha256.slice(0, 12), port: this.port })
  }

  get port() { return this.server?.port ?? this.options.port ?? SPEECH_SERVICE_PORT }
  get hostname() { return this.server?.hostname || this.options.hostname || '127.0.0.1' }

  stop() {
    for (const job of this.jobs.values()) job.controller.abort()
    this.server?.stop(true)
    this.server = null
  }

  private corsHeaders() {
    return {
      'Access-Control-Allow-Origin': this.options.allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-AIStudio-Original-Name, X-AIStudio-Byte-Size',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
    }
  }

  private internalAuthorized(request: Request) {
    const supplied = request.headers.get('x-aistudio-speech-secret') || ''
    return safeEqual(supplied, this.options.coordinatorSecret)
  }

  private log(stage: string, fields: Record<string, unknown> = {}) {
    const line = `[speech] stage=${stage} ${Object.entries(fields).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, ' ').slice(0, 500)}`).join(' ')}\n`
    try {
      try { if (statSync(this.logPath).size > 5 * 1024 * 1024) renameSync(this.logPath, `${this.logPath}.1`) } catch {}
      appendFileSync(this.logPath, line, { mode: 0o600 })
    } catch {}
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') {
      return origin === this.options.allowedOrigin
        ? new Response(null, { status: 204, headers: this.corsHeaders() })
        : Response.json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 })
    }
    if (url.pathname.startsWith('/internal/')) {
      if (!this.internalAuthorized(request)) return Response.json({ ok: false, error: 'not found' }, { status: 404 })
      if (request.method === 'GET' && url.pathname === '/internal/status') {
        return Response.json({ ok: true, status: this.state, active_jobs: this.jobs.size, provider: this.provider.name, ...this.provider.status?.() })
      }
      if (request.method === 'POST' && url.pathname === '/internal/model/install' && this.provider.installModel) {
        try { return Response.json({ ok: true, ...(await this.provider.installModel()) }) }
        catch (error: any) { return Response.json({ ok: false, error: safeErrorCode(error?.code || error?.message) }, { status: 500 }) }
      }
      if (request.method === 'POST' && url.pathname === '/internal/grants') {
        const body = await request.json() as any
        if (!safeId(body.transcription_id) || !safeId(body.user_id) || !safeId(body.device_id)) {
          return Response.json({ ok: false, error: 'INVALID_GRANT_BINDING' }, { status: 400 })
        }
        const issued = this.grants.issue({
          transcriptionId: body.transcription_id,
          userId: body.user_id,
          deviceId: body.device_id,
          ttlMs: Number(body.ttl_ms) || undefined,
        })
        return Response.json({ ok: true, speech_token: issued.token, expires_at: issued.expiresAt })
      }
      const cancel = url.pathname.match(/^\/internal\/transcriptions\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && cancel) {
        const id = decodeURIComponent(cancel[1])
        await this.cancel(id)
        return Response.json({ ok: true, status: 'cancelled' })
      }
      return Response.json({ ok: false, error: 'not found' }, { status: 404 })
    }

    if (origin !== this.options.allowedOrigin) {
      return Response.json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, { status: 403, headers: this.corsHeaders() })
    }
    const upload = url.pathname.match(/^\/transcriptions\/([^/]+)\/audio$/)
    if (request.method !== 'POST' || !upload) return Response.json({ ok: false, error: 'not found' }, { status: 404, headers: this.corsHeaders() })
    const transcriptionId = decodeURIComponent(upload[1])
    const token = (request.headers.get('authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{40,100})$/)?.[1] || ''
    const grant = this.grants.consume(token, transcriptionId)
    if (!grant) return Response.json({ ok: false, error: 'SPEECH_TOKEN_INVALID_OR_EXPIRED' }, { status: 401, headers: this.corsHeaders() })
    this.log('request_received', { transcription_id: transcriptionId, content_type: (request.headers.get('content-type') || '(empty)').split(';')[0].trim().slice(0, 100), received_bytes: Number(request.headers.get('x-aistudio-byte-size') || request.headers.get('content-length') || 0) })
    const startedAt = Date.now()
    try {
      const result = await this.receiveAudio(request, grant)
      return Response.json({ ok: true, ...result }, { status: 202, headers: this.corsHeaders() })
    } catch (error: any) {
      const code = String(error?.message || 'SPEECH_UPLOAD_FAILED')
      const receivedContentType = (request.headers.get('content-type') || '(empty)').split(';')[0].trim().slice(0, 100)
      console.error(`[speech-upload] transcription=${transcriptionId} received_content_type=${receivedContentType} reason=${safeErrorCode(code)}`)
      this.log('failed', {
        transcription_id: transcriptionId,
        stage: safeErrorCode(code),
        error_name: String(error?.name || 'Error').slice(0, 120),
        error_message: safeErrorCode(error?.message || code),
        duration_ms: Date.now() - startedAt,
        exit_code: Number.isInteger(error?.exit_code) ? error.exit_code : '',
      })
      const status = code === 'SPEECH_AUDIO_TOO_LARGE' ? 413 : code.includes('FORMAT') ? 415 : code === 'SPEECH_CANCELLED' ? 409 : 500
      return Response.json({ ok: false, error: code }, { status, headers: this.corsHeaders() })
    }
  }

  private async receiveAudio(request: Request, grant: SpeechGrant) {
    if (!request.body) throw new Error('SPEECH_BODY_REQUIRED')
    let stage = 'temp_write_start'
    const operationStartedAt = Date.now()
    let activeSegmentIndex: number | undefined
    const totalBytes = Number(request.headers.get('x-aistudio-byte-size') || request.headers.get('content-length') || 0)
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) throw new Error('SPEECH_CONTENT_LENGTH_REQUIRED')
    if (totalBytes > SPEECH_MAX_AUDIO_BYTES) throw new Error('SPEECH_AUDIO_TOO_LARGE')
    const nonce = randomBytes(24).toString('hex')
    const temporaryPath = path.join(this.tmpDir, `${nonce}.uploading`)
    const processingPath = path.join(this.tmpDir, `${nonce}.processing`)
    const controller = new AbortController()
    const job = { controller, temporaryPath, processingPath }
    this.jobs.set(grant.transcriptionId, job)
    this.log('temp_write_start', { transcription_id: grant.transcriptionId })
    this.state = 'busy'
    const handle = await open(temporaryPath, 'wx', 0o600)
    let uploadedBytes = 0
    let lastProgressBytes = 0
    let lastProgressAt = 0
    const header = new Uint8Array(64)
    let headerLength = 0
    const reader = request.body.getReader()
    try {
      await this.report(grant, 'uploading', 0, uploadedBytes, totalBytes)
      while (true) {
        if (controller.signal.aborted || request.signal.aborted) throw new Error('SPEECH_CANCELLED')
        const { value, done } = await reader.read()
        if (controller.signal.aborted || request.signal.aborted) throw new Error('SPEECH_CANCELLED')
        if (done) break
        if (!value?.byteLength) continue
        uploadedBytes += value.byteLength
        if (uploadedBytes > SPEECH_MAX_AUDIO_BYTES || uploadedBytes > totalBytes) throw new Error('SPEECH_AUDIO_TOO_LARGE')
        if (headerLength < header.length) {
          const part = value.subarray(0, Math.min(value.length, header.length - headerLength))
          header.set(part, headerLength)
          headerLength += part.length
        }
        await handle.write(value)
        const now = Date.now()
        if (uploadedBytes - lastProgressBytes >= 1024 * 1024 || now - lastProgressAt >= 250) {
          lastProgressBytes = uploadedBytes
          lastProgressAt = now
          await this.report(grant, 'uploading', Math.min(0.99, uploadedBytes / totalBytes), uploadedBytes, totalBytes)
        }
      }
      if (uploadedBytes !== totalBytes) throw new Error('SPEECH_BYTE_SIZE_MISMATCH')
      stage = 'magic_check'
      const detected = resolveAudioFormat(header.subarray(0, headerLength), request.headers.get('content-type') || '')
      if (!detected) throw new Error('SPEECH_AUDIO_FORMAT_INVALID')
      this.log('temp_write_done', { transcription_id: grant.transcriptionId, received_bytes: uploadedBytes })
      this.log('magic_check', { transcription_id: grant.transcriptionId, magic_type: detected.mimeType })
      // The browser no longer sends the original filename. Use an internal,
      // ASCII-only name derived from verified bytes for the local pipeline.
      const originalName = `recording.${detected.extension}`
      await handle.sync()
      await handle.close()
      await rename(temporaryPath, processingPath)
      await this.report(grant, 'processing', 1, uploadedBytes, totalBytes)
      await this.report(grant, 'queued', 1, uploadedBytes, totalBytes)
      this.log('transcode_start', { transcription_id: grant.transcriptionId })
      let lastSegment = 0
      stage = 'transcode_start'
      const result = await this.provider.transcribe({
        inputPath: processingPath, originalName, mimeType: detected.mimeType,
        signal: controller.signal,
        onStage: async (stageName, progress, details) => {
          stage = stageName === 'transcribing' ? 'sensevoice' : stageName
          if (stageName === 'loading_model') this.log('transcode_done', { transcription_id: grant.transcriptionId })
          if (stageName === 'transcribing' && details?.segment_index && details.segment_index !== lastSegment) {
            lastSegment = details.segment_index
            activeSegmentIndex = details.segment_index
            this.log('segment_start', { transcription_id: grant.transcriptionId, segment_index: details.segment_index, segment_count: details.segment_count })
            this.log('sensevoice_start', { transcription_id: grant.transcriptionId, segment_index: details.segment_index, segment_count: details.segment_count })
          }
          await this.report(grant, stageName, progress, uploadedBytes, totalBytes, null, undefined, false, details)
        },
      })
      stage = 'sensevoice_done'
      this.log('sensevoice_done', { transcription_id: grant.transcriptionId, duration_ms: result.processing_ms, segment_count: result.metrics?.segment_count })
      if (controller.signal.aborted) throw new Error('SPEECH_CANCELLED')
      stage = 'result_send'
      await this.report(grant, 'saving', 1, uploadedBytes, totalBytes)
      await this.report(grant, 'completed', 1, uploadedBytes, totalBytes, null, result, true)
      this.log('result_send', { transcription_id: grant.transcriptionId, received_bytes: uploadedBytes, duration_ms: result.processing_ms })
      await unlink(processingPath).catch(() => {})
      this.jobs.delete(grant.transcriptionId)
      this.state = this.jobs.size ? 'busy' : 'ready'
      return { transcription_id: grant.transcriptionId, status: 'completed', uploaded_bytes: uploadedBytes, result }
    } catch (error: any) {
      await handle.close().catch(() => {})
      await unlink(temporaryPath).catch(() => {})
      await unlink(processingPath).catch(() => {})
      this.jobs.delete(grant.transcriptionId)
      this.state = this.jobs.size ? 'busy' : 'ready'
      const code = error instanceof SpeechProviderError ? error.code : error?.message
      const cancelled = code === 'SPEECH_CANCELLED'
      this.log('failed', {
        transcription_id: grant.transcriptionId,
        stage,
        error_name: String(error?.name || 'Error').slice(0, 120),
        error_message: safeErrorCode(code),
        duration_ms: Date.now() - operationStartedAt,
        segment_index: activeSegmentIndex ?? '',
        exit_code: Number.isInteger(error?.exit_code) ? error.exit_code : '',
      })
      await this.report(grant, cancelled ? 'cancelled' : 'failed', 0, uploadedBytes, totalBytes, cancelled ? null : safeErrorCode(code))
      throw new Error(cancelled ? 'SPEECH_CANCELLED' : safeErrorCode(code))
    } finally {
      this.log('cleanup', { transcription_id: grant.transcriptionId })
      reader.releaseLock()
    }
  }

  private async cancel(transcriptionId: string) {
    const job = this.jobs.get(transcriptionId)
    job?.controller.abort()
    if (job) {
      await unlink(job.temporaryPath).catch(() => {})
      await unlink(job.processingPath).catch(() => {})
      this.jobs.delete(transcriptionId)
      this.state = this.jobs.size ? 'busy' : 'ready'
    }
  }

  private async report(grant: SpeechGrant, status: string, progress: number, uploadedBytes: number, totalBytes: number, errorCode: string | null = null, result?: TranscriptionResult, required = false, details?: Record<string, number>) {
    const body = { transcription_id: grant.transcriptionId, user_id: grant.userId, device_id: grant.deviceId, status, progress, uploaded_bytes: uploadedBytes, total_bytes: totalBytes, error_code: errorCode, ...(details || {}), ...(result ? { result } : {}) }
    const transmit = async () => {
      try {
      if (this.options.reportProgress) {
        const ok = await this.options.reportProgress(body)
        if (!ok && required) throw new Error('SPEECH_RESULT_SAVE_FAILED')
        return ok
      }
      const response = await fetch(`${this.options.helperUrl || 'http://127.0.0.1:39481'}/internal/speech/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AIStudio-Speech-Secret': this.options.coordinatorSecret },
        body: JSON.stringify(body),
      })
      if (!response.ok && required) throw new Error('SPEECH_RESULT_SAVE_FAILED')
      return response.ok
      } catch (error) {
        if (required) throw error
        return false
      }
    }
    if (!required) {
      const channel = this.progressChannels.get(grant.transcriptionId) || { running: null, latest: null }
      this.progressChannels.set(grant.transcriptionId, channel)
      channel.latest = transmit
      if (!channel.running) {
        channel.running = (async () => {
          while (channel.latest) {
            const next = channel.latest
            channel.latest = null
            await next()
          }
        })().finally(() => {
          channel.running = null
          if (!channel.latest) this.progressChannels.delete(grant.transcriptionId)
        })
      }
      return true
    }
    const channel = this.progressChannels.get(grant.transcriptionId)
    if (channel?.running) await channel.running
    return transmit()
  }
}

export function cleanupSpeechTemps(tmpDir: string, now = Date.now(), maxAgeMs = SPEECH_TMP_MAX_AGE_MS) {
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
  let removed = 0
  for (const name of readdirSync(tmpDir)) {
    if (!name.endsWith('.uploading') && !name.endsWith('.processing') && !name.endsWith('.16k.wav') && !name.endsWith('.segment.wav')) continue
    const target = path.join(tmpDir, name)
    try {
      if (now - statSync(target).mtimeMs <= maxAgeMs) continue
      unlinkSync(target)
      removed++
    } catch {}
  }
  return removed
}

export function readCoordinatorSecret(filename: string) {
  const secret = readFileSync(filename, 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(secret)) throw new Error('SPEECH_COORDINATOR_SECRET_INVALID')
  return secret
}

function hashToken(value: string) { return createHash('sha256').update(value).digest('hex') }
function safeId(value: unknown) { return /^[A-Za-z0-9_.:-]{6,160}$/.test(String(value || '')) }
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}
export function resolveAudioFormat(header: Uint8Array, mime: string): { extension: 'wav' | 'mp3' | 'm4a' | 'mp4'; mimeType: string } | null {
  const normalized = mime.split(';')[0].trim().toLowerCase()
  const candidates: Array<'wav' | 'mp3' | 'm4a' | 'mp4'> = normalized === 'audio/wav' || normalized === 'audio/x-wav'
    ? ['wav']
    : normalized === 'audio/mpeg' || normalized === 'audio/mp3'
      ? ['mp3']
      : normalized === 'video/mp4'
        ? ['mp4']
        : normalized === 'audio/mp4' || normalized === 'audio/x-m4a' || normalized === 'audio/m4a'
          ? ['m4a', 'mp4']
          : normalized === '' || normalized === 'application/octet-stream'
            ? ['wav', 'mp3', 'm4a', 'mp4']
            : []
  for (const extension of candidates) {
    const detected = detectAudioSignature(header, extension)
    if (detected) return { extension, mimeType: detected }
  }
  return null
}
function safeErrorCode(message: string) {
  return String(message || 'SPEECH_FAILED').replace(/[^A-Z0-9_]/gi, '_').toUpperCase().slice(0, 80)
}
