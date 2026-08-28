export type PairingResult = {
  deviceCredential: string
  connectorWsUrl: string | null
  alreadyBound: boolean
}

export function pairingTokenFromLaunchArgs(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--pair-token') return args[index + 1]?.trim() || null
    if (arg.startsWith('--pair-token=')) return arg.slice('--pair-token='.length).trim() || null
    if (arg.startsWith('aistudio://')) {
      try {
        const deepLink = new URL(arg)
        if (deepLink.protocol === 'aistudio:' && deepLink.hostname === 'pair') {
          return deepLink.searchParams.get('token')?.trim() || null
        }
      } catch {}
    }
  }
  return null
}

export class PairingService {
  constructor(private readonly serverUrl: string) {}

  async complete(input: {
    pairingToken: string
    deviceId: string
    deviceName: string
    platform: string
    connectorVersion: string
    requestId?: string
  }): Promise<PairingResult> {
    const response = await this.post('/api/connectors/claim/complete', {
      claim_token: input.pairingToken,
      device_id: input.deviceId,
      device_name: input.deviceName,
      platform: input.platform,
      connector_version: input.connectorVersion,
    }, input.requestId)
    const connectorWsUrl = safeConnectorWebsocketUrl(this.serverUrl, response.websocket_url)
    const deviceCredential = String(response.device_credential || '')
    if (!deviceCredential) throw new Error('pairing response did not include a device credential')
    return { deviceCredential, connectorWsUrl, alreadyBound: response.already_bound === true }
  }

  private async post(pathname: string, body: Record<string, string>, requestId?: string): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const safeRequestId = String(requestId || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100)
    if (safeRequestId) headers['X-AIStudio-Claim-Request-ID'] = safeRequestId
    const response = await fetch(`${this.serverUrl}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const data = await response.json() as any
    if (!response.ok) throw new Error(data.error || 'pairing failed')
    return data
  }
}

/**
 * The Helper already knows the working HTTP authority because it just used it
 * to complete the claim. A stale Server CONNECTOR_WS_URL must not redirect the
 * newly-bound device to a different host or port and leave Registry offline.
 */
export function safeConnectorWebsocketUrl(serverUrl: string, advertised: unknown): string {
  const server = new URL(serverUrl)
  const fallback = new URL(server.toString())
  fallback.protocol = server.protocol === 'https:' ? 'wss:' : 'ws:'
  fallback.pathname = '/connector'
  fallback.search = ''
  fallback.hash = ''
  if (!advertised) return fallback.toString()
  try {
    const candidate = new URL(String(advertised), server)
    candidate.protocol = candidate.protocol === 'https:' ? 'wss:' : candidate.protocol === 'http:' ? 'ws:' : candidate.protocol
    if (!['ws:', 'wss:'].includes(candidate.protocol) || candidate.host !== server.host) return fallback.toString()
    candidate.hash = ''
    return candidate.toString()
  } catch {
    return fallback.toString()
  }
}
