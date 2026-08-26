import { loadConfig, saveDevice } from './config.ts'
import { LocalCodexExecutor } from './codex.ts'
import { runConnector } from './websocket.ts'

async function pair(serverUrl: string, deviceName: string, pairingCode: string): Promise<string> {
  const response = await fetch(`${serverUrl}/api/connectors/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairingCode, device_name: deviceName }),
  })
  const data = await response.json() as any
  if (!response.ok) throw new Error(data.error || 'pairing failed')
  return data.device_token
}

const config = loadConfig()
LocalCodexExecutor.verify(config.codexBinary)
let deviceToken = config.deviceToken
if (!deviceToken) {
  const pairingCode = config.pairingCode || prompt('请输入网页 Settings → Devices 中显示的 6 位配对码：')?.trim()
  if (!pairingCode) throw new Error('pairing code required')
  deviceToken = await pair(config.serverUrl, config.deviceName, pairingCode)
  saveDevice(config, deviceToken)
  console.log('[connector] device paired; token saved locally with owner-only permissions')
}

const executor = new LocalCodexExecutor({ binary: config.codexBinary, cwd: config.codexCwd, stateDir: config.stateDir })
await runConnector(config, deviceToken, executor)

