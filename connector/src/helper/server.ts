export type HelperCodexStatus = {
  runtime_installed: boolean
  runtime_version: string | null
  logged_in: boolean
  status:
    | 'CODEX_RUNTIME_NOT_INSTALLED'
    | 'CODEX_RUNTIME_INSTALLING'
    | 'CODEX_RUNTIME_ERROR'
    | 'CODEX_NOT_LOGGED_IN'
    | 'CODEX_AUTHENTICATING'
    | 'CODEX_READY'
}

export type LocalHelperStatus = {
  helper: 'online'
  device: { bound: boolean; device_id: string; device_name: string }
  server: { connected: boolean; error_code?: string | null }
  platform: string
  connector_version: string
  codex: HelperCodexStatus
  speech?: { status: 'offline' | 'starting' | 'ready' | 'busy' | 'error' }
}

export type LocalHelperServerOptions = {
  hostname?: '127.0.0.1'
  port?: number
  allowedOrigin: string
  status: () => LocalHelperStatus
  claim: (claimToken: string, requestId: string | null) => Promise<{ bound: boolean; already_bound: boolean }>
  unbind: (deviceId: string) => Promise<{ unbound: true }>
  codexLogin: () => Promise<{ started: true; status: 'CODEX_AUTHENTICATING' }>
  codexRestart?: () => Promise<void>
  speechStatus?: () => Promise<string | { status: string; model?: string; runtime?: string; provider?: string; active_jobs?: number }>
  speechInstall?: () => Promise<{ model: string; runtime: string }>
  speechGrant?: (transcriptionId: string, sessionProof: string) => Promise<{ speechToken: string; expiresAt: string; speechUrl: string }>
  speechCancel?: (transcriptionId: string) => Promise<{ cancelled: true }>
  speechProgress?: (body: Record<string, unknown>) => Promise<void>
  speechSecret?: string
}

export class LocalHelperServer {
  private server: ReturnType<typeof Bun.serve> | null = null

  constructor(private readonly options: LocalHelperServerOptions) {}

  start(): void {
    if (this.server) return
    const hostname = this.options.hostname || '127.0.0.1'
    if (hostname !== '127.0.0.1') throw new Error('LOCAL_HELPER_MUST_BIND_LOOPBACK')
    this.server = Bun.serve({
      hostname,
      port: this.options.port ?? 39481,
      fetch: (request) => this.handle(request),
    })
  }

  get hostname(): string { return this.server?.hostname || this.options.hostname || '127.0.0.1' }
  get port(): number { return this.server?.port || this.options.port || 39481 }

  stop(): void {
    this.server?.stop(true)
    this.server = null
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    if (origin && origin !== this.options.allowedOrigin) {
      return Response.json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 })
    }

    if (request.method === 'OPTIONS') {
      if (origin !== this.options.allowedOrigin) {
        return Response.json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 })
      }
      return new Response(null, { status: 204, headers: this.corsHeaders(true) })
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      return Response.json(this.options.status(), { headers: origin ? this.corsHeaders(false) : undefined })
    }

    if (request.method === 'GET' && url.pathname === '/codex/status') {
      return Response.json(this.options.status().codex, { headers: origin ? this.corsHeaders(false) : undefined })
    }

    if (request.method === 'GET' && url.pathname === '/speech/status' && this.options.speechStatus) {
      const speech = await this.options.speechStatus()
      return Response.json({ ok: true, ...(typeof speech === 'string' ? { status: speech } : speech) }, { headers: origin ? this.corsHeaders(false) : undefined })
    }

    if (request.method === 'POST' && url.pathname === '/speech/model/install' && this.options.speechInstall) {
      if (origin !== this.options.allowedOrigin) return Response.json({ ok: false, error: 'ORIGIN_REQUIRED' }, { status: 403 })
      try { return Response.json({ ok: true, ...(await this.options.speechInstall()) }, { headers: this.corsHeaders(false) }) }
      catch { return Response.json({ ok: false, error: 'SPEECH_MODEL_INSTALL_FAILED' }, { status: 500, headers: this.corsHeaders(false) }) }
    }

    if (request.method === 'POST' && url.pathname === '/speech/grant' && this.options.speechGrant) {
      if (origin !== this.options.allowedOrigin) return Response.json({ ok: false, error: 'ORIGIN_REQUIRED' }, { status: 403 })
      try {
        const body = await request.json() as any
        if ('user_id' in body || 'device_id' in body) throw new Error('IDENTITY_NOT_ACCEPTED')
        const result = await this.options.speechGrant(String(body.transcription_id || ''), String(body.session_proof || ''))
        return Response.json({ ok: true, speech_token: result.speechToken, expires_at: result.expiresAt, speech_url: result.speechUrl }, { headers: this.corsHeaders(false) })
      } catch (error: any) {
        return Response.json({ ok: false, error: safeSpeechError(error?.message) }, { status: 400, headers: this.corsHeaders(false) })
      }
    }

    if (request.method === 'POST' && url.pathname === '/speech/cancel' && this.options.speechCancel) {
      if (origin !== this.options.allowedOrigin) return Response.json({ ok: false, error: 'ORIGIN_REQUIRED' }, { status: 403 })
      try {
        const body = await request.json() as any
        const result = await this.options.speechCancel(String(body.transcription_id || ''))
        return Response.json({ ok: true, ...result }, { headers: this.corsHeaders(false) })
      } catch { return Response.json({ ok: false, error: 'SPEECH_CANCEL_FAILED' }, { status: 400, headers: this.corsHeaders(false) }) }
    }

    if (request.method === 'POST' && url.pathname === '/internal/speech/progress' && this.options.speechProgress) {
      if (!this.options.speechSecret || request.headers.get('x-aistudio-speech-secret') !== this.options.speechSecret) {
        return Response.json({ ok: false, error: 'not found' }, { status: 404 })
      }
      try {
        await this.options.speechProgress(await request.json() as Record<string, unknown>)
        return Response.json({ ok: true })
      } catch { return Response.json({ ok: false, error: 'SPEECH_PROGRESS_REJECTED' }, { status: 400 }) }
    }

    if (request.method === 'POST' && url.pathname === '/claim') {
      if (origin !== this.options.allowedOrigin) {
        return Response.json({ ok: false, error: 'ORIGIN_REQUIRED' }, { status: 403 })
      }
      try {
        const body = await request.json() as Record<string, unknown>
        if ('user_id' in body || 'username' in body || 'password' in body) {
          return Response.json({ ok: false, error: 'USER_IDENTITY_NOT_ACCEPTED' }, {
            status: 400,
            headers: this.corsHeaders(false),
          })
        }
        const claimToken = typeof body.claim_token === 'string' ? body.claim_token.trim() : ''
        const requestId = safeRequestId(body.request_id)
        if (!claimToken) throw new Error('claim_token required')
        const result = await this.options.claim(claimToken, requestId)
        return Response.json({ ok: true, ...result }, { headers: this.corsHeaders(false) })
      } catch (error: any) {
        return Response.json({ ok: false, error: safeClaimError(error?.message) }, {
          status: 400,
          headers: this.corsHeaders(false),
        })
      }
    }

    if (request.method === 'POST' && url.pathname === '/unbind') {
      if (origin !== this.options.allowedOrigin) {
        return Response.json({ ok: false, error: 'ORIGIN_REQUIRED' }, { status: 403 })
      }
      try {
        const body = await request.json() as Record<string, unknown>
        if ('user_id' in body || 'username' in body || 'password' in body || 'device_token' in body) {
          return Response.json({ ok: false, error: 'IDENTITY_OR_CREDENTIAL_NOT_ACCEPTED' }, {
            status: 400,
            headers: this.corsHeaders(false),
          })
        }
        const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : ''
        if (!deviceId) throw new Error('device_id required')
        const result = await this.options.unbind(deviceId)
        return Response.json({ ok: true, ...result }, { headers: this.corsHeaders(false) })
      } catch {
        return Response.json({ ok: false, error: 'DEVICE_CREDENTIAL_CLEAR_FAILED' }, {
          status: 400,
          headers: this.corsHeaders(false),
        })
      }
    }

    if (request.method === 'POST' && url.pathname === '/codex/login') {
      if (origin !== this.options.allowedOrigin) {
        return Response.json({ ok: false, error: 'ORIGIN_REQUIRED' }, { status: 403 })
      }
      try {
        const result = await this.options.codexLogin()
        return Response.json({ ok: true, ...result }, { headers: this.corsHeaders(false) })
      } catch (error: any) {
        return Response.json({ ok: false, error: safeCodexError(error?.message) }, {
          status: 400,
          headers: this.corsHeaders(false),
        })
      }
    }

    if (request.method === 'POST' && url.pathname === '/codex/restart' && this.options.codexRestart) {
      if (origin !== this.options.allowedOrigin) {
        return Response.json({ ok: false, error: 'ORIGIN_REQUIRED' }, { status: 403 })
      }
      try {
        await this.options.codexRestart()
        return Response.json({ ok: true }, { headers: this.corsHeaders(false) })
      } catch (error: any) {
        return Response.json({ ok: false, error: safeCodexError(error?.message) }, {
          status: 400,
          headers: this.corsHeaders(false),
        })
      }
    }

    return Response.json({ ok: false, error: 'not found' }, { status: 404 })
  }

  private corsHeaders(preflight: boolean): Headers {
    const headers = new Headers({
      'Access-Control-Allow-Origin': this.options.allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    })
    if (!preflight) headers.set('Cache-Control', 'no-store')
    return headers
  }
}

function safeClaimError(message: string): string {
  if (message === 'DEVICE_ALREADY_BOUND_TO_ANOTHER_USER') return message
  if (/invalid|expired/i.test(message)) return 'CLAIM_TOKEN_REJECTED'
  if (/DEVICE_CREDENTIAL_SAVE_FAILED/i.test(message)) return 'DEVICE_CREDENTIAL_SAVE_FAILED'
  return 'CLAIM_FAILED'
}

function safeRequestId(value: unknown): string | null {
  const id = String(value || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100)
  return id || null
}

function safeCodexError(message: string): string {
  if (/NOT_LOGGED_IN/i.test(message)) return 'CODEX_NOT_LOGGED_IN'
  if (/NOT_INSTALLED|BUNDLED_RUNTIME/i.test(message)) return 'CODEX_RUNTIME_NOT_INSTALLED'
  if (/AUTHENTICAT|LOGIN/i.test(message)) return 'CODEX_AUTHENTICATION_ERROR'
  return 'CODEX_RUNTIME_ERROR'
}

function safeSpeechError(message: string): string {
  if (/ORIGIN/i.test(message)) return 'ORIGIN_NOT_ALLOWED'
  if (/PROOF|INVALID|EXPIRED/i.test(message)) return 'SPEECH_SESSION_PROOF_REJECTED'
  if (/OFFLINE|UNAVAILABLE|fetch failed/i.test(message)) return 'SPEECH_SERVICE_UNAVAILABLE'
  return 'SPEECH_GRANT_FAILED'
}
