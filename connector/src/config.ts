import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { homedir, hostname } from 'os'

const configDir = process.env.AI_STUDIO_CONNECTOR_HOME || path.join(homedir(), '.ai-studio-connector')
const configFile = path.join(configDir, 'device.json')

type SavedConfig = { server_url?: string; device_token?: string; device_name?: string }

function readSaved(): SavedConfig {
  try { return existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {} } catch { return {} }
}

export type ConnectorConfig = {
  serverUrl: string
  deviceName: string
  deviceToken: string | null
  pairingCode: string | null
  codexBinary: string
  codexCwd: string
  stateDir: string
}

export function loadConfig(): ConnectorConfig {
  const saved = readSaved()
  const serverUrl = (process.env.AI_STUDIO_SERVER_URL || saved.server_url || '').replace(/\/$/, '')
  if (!serverUrl) throw new Error('AI_STUDIO_SERVER_URL is required, for example https://studio.example.com')
  return {
    serverUrl,
    deviceName: process.env.AI_STUDIO_DEVICE_NAME || saved.device_name || hostname(),
    deviceToken: process.env.AI_STUDIO_DEVICE_TOKEN || saved.device_token || null,
    pairingCode: process.env.AI_STUDIO_PAIRING_CODE || null,
    codexBinary: process.env.CODEX_BINARY_PATH || 'codex',
    codexCwd: process.env.AI_STUDIO_CODEX_CWD || process.cwd(),
    stateDir: path.join(configDir, 'state'),
  }
}

export function saveDevice(config: ConnectorConfig, deviceToken: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  writeFileSync(configFile, JSON.stringify({
    server_url: config.serverUrl,
    device_token: deviceToken,
    device_name: config.deviceName,
  }, null, 2), { mode: 0o600 })
}

