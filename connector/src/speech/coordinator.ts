import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import path from 'path'
import type { ConnectorConfig } from '../config/index.ts'

export type SpeechServiceState = 'offline' | 'starting' | 'ready' | 'busy' | 'error'
export type SpeechServiceDetails = { status: SpeechServiceState; model?: string; runtime?: string; provider?: string; active_jobs?: number }

export class SpeechCoordinator {
  readonly secretFile: string
  readonly secret: string
  readonly serviceUrl: string

  constructor(
    private readonly config: ConnectorConfig,
    private readonly deviceToken: () => string | null,
    serviceUrl = `http://127.0.0.1:${Number(process.env.AI_STUDIO_SPEECH_PORT || 39482)}`,
  ) {
    this.serviceUrl = serviceUrl
    const speechDir = path.join(config.appSupportDir, 'speech')
    mkdirSync(speechDir, { recursive: true, mode: 0o700 })
    this.secretFile = path.join(speechDir, 'coordinator.secret')
    if (!existsSync(this.secretFile)) {
      writeFileSync(this.secretFile, randomBytes(32).toString('base64url'), { mode: 0o600 })
    }
    chmodSync(this.secretFile, 0o600)
    this.secret = readFileSync(this.secretFile, 'utf8').trim()
  }

  async status(): Promise<SpeechServiceState> {
    return (await this.details()).status
  }

  async details(): Promise<SpeechServiceDetails> {
    try {
      const response = await fetch(`${this.serviceUrl}/internal/status`, {
        headers: { 'X-AIStudio-Speech-Secret': this.secret }, signal: AbortSignal.timeout(1_000),
      })
      if (!response.ok) return { status: 'error' }
      const body = await response.json() as any
      return { status: ['ready', 'busy', 'error'].includes(body.status) ? body.status : 'error', model: body.model, runtime: body.runtime, provider: body.provider, active_jobs: body.active_jobs }
    } catch { return { status: 'offline' } }
  }

  async installModel() {
    const response = await fetch(`${this.serviceUrl}/internal/model/install`, { method: 'POST', headers: { 'X-AIStudio-Speech-Secret': this.secret } })
    const body = await response.json() as any
    if (!response.ok || !body.ok) throw new Error(body.error || 'SPEECH_MODEL_INSTALL_FAILED')
    return body as { model: string; runtime: string }
  }

  async grant(transcriptionId: string, sessionProof: string) {
    const deviceToken = this.deviceToken()
    if (!deviceToken) throw new Error('DEVICE_NOT_BOUND')
    const verified = await fetch(`${this.config.serverUrl}/api/transcriptions/${encodeURIComponent(transcriptionId)}/speech-proof/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AIStudio-Device-Token': deviceToken },
      body: JSON.stringify({ session_proof: sessionProof }),
    })
    const verification = await verified.json() as any
    if (!verified.ok || !verification.ok) throw new Error(verification.error || 'SPEECH_SESSION_PROOF_REJECTED')
    const response = await fetch(`${this.serviceUrl}/internal/grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AIStudio-Speech-Secret': this.secret },
      body: JSON.stringify({
        transcription_id: transcriptionId,
        user_id: verification.user_id,
        device_id: verification.device_id,
        ttl_ms: 3 * 60_000,
      }),
    })
    const body = await response.json() as any
    if (!response.ok || !body.ok) throw new Error(body.error || 'SPEECH_SERVICE_UNAVAILABLE')
    return { speechToken: body.speech_token, expiresAt: body.expires_at, speechUrl: this.serviceUrl }
  }

  async cancel(transcriptionId: string) {
    const deviceToken = this.deviceToken()
    if (!deviceToken) throw new Error('DEVICE_NOT_BOUND')
    const verified = await fetch(`${this.config.serverUrl}/api/transcriptions/${encodeURIComponent(transcriptionId)}/cancel/verify`, {
      method: 'POST', headers: { 'X-AIStudio-Device-Token': deviceToken },
    })
    if (!verified.ok) throw new Error('SPEECH_CANCEL_NOT_AUTHORIZED')
    const response = await fetch(`${this.serviceUrl}/internal/transcriptions/${encodeURIComponent(transcriptionId)}/cancel`, {
      method: 'POST', headers: { 'X-AIStudio-Speech-Secret': this.secret },
    })
    if (!response.ok) throw new Error('SPEECH_CANCEL_FAILED')
    return { cancelled: true as const }
  }

  async forwardProgress(body: Record<string, unknown>) {
    const deviceToken = this.deviceToken()
    if (!deviceToken) throw new Error('DEVICE_NOT_BOUND')
    const id = String(body.transcription_id || '')
    const response = await fetch(`${this.config.serverUrl}/api/transcriptions/${encodeURIComponent(id)}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AIStudio-Device-Token': deviceToken },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error('SPEECH_PROGRESS_REJECTED')
  }
}
