import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { homedir, hostname } from 'os'
import { randomUUID } from 'crypto'
import { loadConnectorTimeouts } from '../../../src/connector/timeouts.ts'
import { pairingTokenFromLaunchArgs } from '../pairing/service.ts'

const configDir = process.env.AI_STUDIO_CONNECTOR_HOME || path.join(homedir(), '.ai-studio')
const configFile = path.join(configDir, 'connector.json')
const legacyConfigFile = path.join(homedir(), '.ai-studio-connector', 'device.json')

type SavedConfig = {
  server_url?: string
  connector_ws_url?: string
  device_token?: string
  device_name?: string
  device_id?: string
}

function readSaved(): SavedConfig {
  try {
    if (existsSync(configFile)) return JSON.parse(readFileSync(configFile, 'utf8'))
    if (existsSync(legacyConfigFile)) return JSON.parse(readFileSync(legacyConfigFile, 'utf8'))
  } catch {}
  return {}
}

export type ConnectorConfig = {
  serverUrl: string
  connectorWsUrl: string | null
  deviceName: string
  deviceId: string
  platform: string
  connectorVersion: string
  webOrigin: string
  helperHost: '127.0.0.1'
  helperPort: number
  deviceToken: string | null
  pairingToken: string | null
  codexBinary: string
  codexCwd: string
  stateDir: string
  connectTimeoutMs: number
  executionTimeoutMs: number
}

export function loadConfig(): ConnectorConfig {
  const saved = readSaved()
  const timeouts = loadConnectorTimeouts()
  const serverUrl = (process.env.AI_STUDIO_SERVER_URL || saved.server_url || '').replace(/\/$/, '')
  if (!serverUrl) throw new Error('AI_STUDIO_SERVER_URL is required, for example http://nas.local:3998')
  const webOrigin = process.env.AI_STUDIO_WEB_ORIGIN || new URL(serverUrl).origin
  const deviceId = process.env.AI_STUDIO_DEVICE_ID || saved.device_id || `dev_${randomUUID()}`
  if (!existsSync(configFile) || (!saved.device_id && !process.env.AI_STUDIO_DEVICE_ID)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    writeFileSync(configFile, JSON.stringify({ ...saved, device_id: deviceId }, null, 2), { mode: 0o600 })
    chmodSync(configFile, 0o600)
  }
  return {
    serverUrl,
    connectorWsUrl: process.env.CONNECTOR_WS_URL || saved.connector_ws_url || null,
    deviceName: process.env.AI_STUDIO_DEVICE_NAME || saved.device_name || hostname(),
    deviceId,
    platform: process.platform,
    connectorVersion: process.env.AI_STUDIO_CONNECTOR_VERSION || '0.1.0',
    webOrigin,
    helperHost: '127.0.0.1',
    helperPort: Number(process.env.AI_STUDIO_HELPER_PORT || 39481),
    deviceToken: process.env.AI_STUDIO_DEVICE_TOKEN || saved.device_token || null,
    pairingToken: process.env.AI_STUDIO_PAIRING_TOKEN || pairingTokenFromLaunchArgs(process.argv.slice(2)),
    codexBinary: process.env.CODEX_BINARY_PATH || 'codex',
    codexCwd: process.env.AI_STUDIO_CODEX_CWD || process.cwd(),
    stateDir: path.join(configDir, 'state'),
    connectTimeoutMs: timeouts.connectTimeoutMs,
    executionTimeoutMs: timeouts.executionTimeoutMs,
  }
}

export function saveDevice(config: ConnectorConfig, deviceToken: string, connectorWsUrl?: string | null): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  writeFileSync(configFile, JSON.stringify({
    server_url: config.serverUrl,
    connector_ws_url: connectorWsUrl || config.connectorWsUrl || undefined,
    device_token: deviceToken,
    device_name: config.deviceName,
    device_id: config.deviceId,
  }, null, 2), { mode: 0o600 })
  chmodSync(configFile, 0o600)
}
