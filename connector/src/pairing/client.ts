export type PairingResult = { deviceToken: string; connectorWsUrl: string | null }

export async function pairDevice(serverUrl: string, deviceName: string, pairingCode: string): Promise<PairingResult> {
  const response = await fetch(`${serverUrl}/api/connectors/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairingCode, device_name: deviceName }),
  })
  const data = await response.json() as any
  if (!response.ok) throw new Error(data.error || 'pairing failed')
  let connectorWsUrl: string | null = null
  if (data.websocket_url) {
    const ws = new URL(String(data.websocket_url), serverUrl)
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : ws.protocol === 'http:' ? 'ws:' : ws.protocol
    connectorWsUrl = ws.toString()
  }
  return {
    deviceToken: String(data.device_token || ''),
    connectorWsUrl,
  }
}
