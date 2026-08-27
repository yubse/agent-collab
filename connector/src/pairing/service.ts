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
  }): Promise<PairingResult> {
    const response = await this.post('/api/connectors/claim/complete', {
      claim_token: input.pairingToken,
      device_id: input.deviceId,
      device_name: input.deviceName,
      platform: input.platform,
      connector_version: input.connectorVersion,
    })
    let connectorWsUrl: string | null = null
    if (response.websocket_url) {
      const ws = new URL(String(response.websocket_url), this.serverUrl)
      ws.protocol = ws.protocol === 'https:' ? 'wss:' : ws.protocol === 'http:' ? 'ws:' : ws.protocol
      connectorWsUrl = ws.toString()
    }
    const deviceCredential = String(response.device_credential || '')
    if (!deviceCredential) throw new Error('pairing response did not include a device credential')
    return { deviceCredential, connectorWsUrl, alreadyBound: response.already_bound === true }
  }

  private async post(pathname: string, body: Record<string, string>): Promise<any> {
    const response = await fetch(`${this.serverUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await response.json() as any
    if (!response.ok) throw new Error(data.error || 'pairing failed')
    return data
  }
}
