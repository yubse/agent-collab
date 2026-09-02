import path from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync } from 'fs'
import { readCoordinatorSecret, SpeechService } from './service.ts'
import { resolveCodexProxyEnvironment } from '../network/proxy.ts'

const appSupportDir = process.env.AI_STUDIO_APP_SUPPORT_DIR
  || path.join(homedir(), 'Library', 'Application Support', 'AIStudio')
const secretFile = process.env.AI_STUDIO_SPEECH_SECRET_FILE
  || path.join(appSupportDir, 'speech', 'coordinator.secret')
const installed = (() => {
  try {
    const filename = process.env.AI_STUDIO_HELPER_CONFIG || '/Library/Application Support/AIStudio/config/helper.json'
    return existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) as { server_url?: string; web_origin?: string } : {}
  } catch { return {} }
})()
const serverUrl = process.env.AI_STUDIO_SERVER_URL || installed.server_url || ''
const allowedOrigin = process.env.AI_STUDIO_WEB_ORIGIN || installed.web_origin || (serverUrl ? new URL(serverUrl).origin : '')
if (!allowedOrigin) throw new Error('AI_STUDIO_WEB_ORIGIN is required')
const proxy = resolveCodexProxyEnvironment(serverUrl)

const service = new SpeechService({
  appSupportDir,
  allowedOrigin,
  coordinatorSecret: readCoordinatorSecret(secretFile),
  port: Number(process.env.AI_STUDIO_SPEECH_PORT || 39482),
  downloadEnv: proxy.environment,
})
service.start()
console.log('[speech] status=ready address=http://127.0.0.1:39482')
const shutdown = () => { service.stop(); process.exit(0) }
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
await new Promise<never>(() => {})
