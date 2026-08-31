import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { homedir, hostname } from 'os'
import { randomUUID } from 'crypto'
import { loadConnectorTimeouts } from '../../../src/connector/timeouts.ts'
import { pairingTokenFromLaunchArgs, safeConnectorWebsocketUrl } from '../pairing/service.ts'
import {
  resolveCodexProxyEnvironment,
  type ProxySource,
  type ProxyType,
} from '../network/proxy.ts'

type SavedDevice = {
  server_url?: string
  connector_ws_url?: string
  device_token?: string
  device_name?: string
  device_id?: string
}

type InstalledHelperConfig = {
  server_url?: string
  web_origin?: string
  bundled_codex_path?: string
}

function readJson<T>(filename: string): T | null {
  try { return existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) as T : null }
  catch { return null }
}

function defaultBundledRuntimePath(): string | null {
  const candidate = path.resolve(path.dirname(process.execPath), '..', 'bundled-runtime', 'codex')
  return existsSync(candidate) ? candidate : null
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
  codexHome: string
  appSupportDir: string
  managedCodexPath: string
  bundledCodexPath: string | null
  useSystemCodex: boolean
  stateDir: string
  connectTimeoutMs: number
  executionTimeoutMs: number
  codexWorkerCount: number
  codexProxyEnvironment: Record<string, string>
  codexProxySource: ProxySource
  codexProxyType: ProxyType
}

export function parseCodexWorkerCount(value: string | undefined): number {
  const parsed = Number.parseInt(String(value || '4'), 10)
  if (!Number.isFinite(parsed)) return 4
  return Math.min(4, Math.max(1, parsed))
}

export function loadConfig(): ConnectorConfig {
  const userHome = homedir()
  const appSupportDir = process.env.AI_STUDIO_APP_SUPPORT_DIR
    || path.join(userHome, 'Library', 'Application Support', 'AIStudio')
  const credentialsDir = path.join(appSupportDir, 'credentials')
  const deviceFile = path.join(credentialsDir, 'device.json')
  const legacyFiles = [
    path.join(userHome, '.ai-studio', 'connector.json'),
    path.join(userHome, '.ai-studio-connector', 'device.json'),
  ]
  const saved = readJson<SavedDevice>(deviceFile)
    || legacyFiles.map((filename) => readJson<SavedDevice>(filename)).find(Boolean)
    || {}
  const installed = readJson<InstalledHelperConfig>(
    process.env.AI_STUDIO_HELPER_CONFIG || '/Library/Application Support/AIStudio/config/helper.json',
  ) || {}
  const timeouts = loadConnectorTimeouts()
  const serverUrl = (process.env.AI_STUDIO_SERVER_URL || installed.server_url || saved.server_url || '').replace(/\/$/, '')
  if (!serverUrl) throw new Error('AI_STUDIO_SERVER_URL is required, for example http://nas.local:3998')
  const connectorWsUrl = process.env.CONNECTOR_WS_URL
    || (saved.connector_ws_url ? safeConnectorWebsocketUrl(serverUrl, saved.connector_ws_url) : null)
  const webOrigin = process.env.AI_STUDIO_WEB_ORIGIN || installed.web_origin || new URL(serverUrl).origin
  const proxy = resolveCodexProxyEnvironment(serverUrl)
  const deviceId = process.env.AI_STUDIO_DEVICE_ID || saved.device_id || `dev_${randomUUID()}`
  mkdirSync(credentialsDir, { recursive: true, mode: 0o700 })
  if (!existsSync(deviceFile)) {
    writeFileSync(deviceFile, JSON.stringify({ ...saved, device_id: deviceId }, null, 2), { mode: 0o600 })
    chmodSync(deviceFile, 0o600)
  }
  const runtimeDir = path.join(appSupportDir, 'runtime')
  const bundledCodexPath = process.env.AI_STUDIO_BUNDLED_CODEX_PATH
    || installed.bundled_codex_path
    || defaultBundledRuntimePath()
  const workspaceDir = process.env.AI_STUDIO_CODEX_CWD || path.join(appSupportDir, 'workspace')
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })
  return {
    serverUrl,
    connectorWsUrl,
    deviceName: process.env.AI_STUDIO_DEVICE_NAME || saved.device_name || hostname(),
    deviceId,
    platform: process.platform,
    connectorVersion: process.env.AI_STUDIO_CONNECTOR_VERSION || '0.2.1',
    webOrigin,
    helperHost: '127.0.0.1',
    helperPort: Number(process.env.AI_STUDIO_HELPER_PORT || 39481),
    deviceToken: process.env.AI_STUDIO_DEVICE_TOKEN || saved.device_token || null,
    pairingToken: process.env.AI_STUDIO_PAIRING_TOKEN || pairingTokenFromLaunchArgs(process.argv.slice(2)),
    codexBinary: process.env.CODEX_BINARY_PATH || 'codex',
    codexCwd: workspaceDir,
    codexHome: process.env.AI_STUDIO_CODEX_HOME || path.join(appSupportDir, 'codex-home'),
    appSupportDir,
    managedCodexPath: process.env.AI_STUDIO_MANAGED_CODEX_PATH || path.join(runtimeDir, 'codex'),
    bundledCodexPath: bundledCodexPath || null,
    useSystemCodex: process.env.USE_SYSTEM_CODEX === '1',
    stateDir: path.join(appSupportDir, 'state'),
    connectTimeoutMs: timeouts.connectTimeoutMs,
    executionTimeoutMs: timeouts.executionTimeoutMs,
    codexWorkerCount: parseCodexWorkerCount(process.env.AI_STUDIO_CODEX_WORKERS),
    codexProxyEnvironment: proxy.environment,
    codexProxySource: proxy.source,
    codexProxyType: proxy.type,
  }
}

export function saveDevice(config: ConnectorConfig, deviceToken: string, connectorWsUrl?: string | null): void {
  const credentialsDir = path.join(config.appSupportDir, 'credentials')
  const deviceFile = path.join(credentialsDir, 'device.json')
  mkdirSync(credentialsDir, { recursive: true, mode: 0o700 })
  writeFileSync(deviceFile, JSON.stringify({
    server_url: config.serverUrl,
    connector_ws_url: connectorWsUrl || config.connectorWsUrl || undefined,
    device_token: deviceToken,
    device_name: config.deviceName,
    device_id: config.deviceId,
  }, null, 2), { mode: 0o600 })
  chmodSync(deviceFile, 0o600)
}

export function clearDeviceCredential(config: ConnectorConfig): void {
  const credentialsDir = path.join(config.appSupportDir, 'credentials')
  const deviceFile = path.join(credentialsDir, 'device.json')
  mkdirSync(credentialsDir, { recursive: true, mode: 0o700 })
  writeFileSync(deviceFile, JSON.stringify({
    server_url: config.serverUrl,
    connector_ws_url: config.connectorWsUrl || undefined,
    device_name: config.deviceName,
    device_id: config.deviceId,
  }, null, 2), { mode: 0o600 })
  chmodSync(deviceFile, 0o600)
}
