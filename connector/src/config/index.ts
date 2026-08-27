import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { homedir, hostname } from 'os'
import { loadConnectorTimeouts } from '../../../src/connector/timeouts.ts'

const configDir = process.env.AI_STUDIO_CONNECTOR_HOME || path.join(homedir(), '.ai-studio-connector')
const configFile = path.join(configDir, 'device.json')

type SavedConfig = {
  server_url?: string
  connector_ws_url?: string
  device_token?: string
  device_name?: string
}

function readSaved(): SavedConfig {
  try { return existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {} } catch { return {} }
}

export type ConnectorConfig = {
  serverUrl: string
  connectorWsUrl: string | null
  deviceName: string
  deviceToken: string | null
  pairingCode: string | null
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
  return {
    serverUrl,
    connectorWsUrl: process.env.CONNECTOR_WS_URL || saved.connector_ws_url || null,
    deviceName: process.env.AI_STUDIO_DEVICE_NAME || saved.device_name || hostname(),
    deviceToken: process.env.AI_STUDIO_DEVICE_TOKEN || saved.device_token || null,
    pairingCode: process.env.AI_STUDIO_PAIRING_CODE || null,
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
  }, null, 2), { mode: 0o600 })
}
