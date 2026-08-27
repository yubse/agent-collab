import { loadConfig, saveDevice } from './config/index.ts'
import { detectCodexStatus } from './codex/preflight.ts'
import { LocalCodexExecutor } from './codex/executor.ts'
import { ExecutionRunner } from './execution/runner.ts'
import { runConnector } from './connection/client.ts'
import { PairingService } from './pairing/service.ts'
import { ConnectorStateStore } from './state/store.ts'
import { LocalHelperServer } from './helper/server.ts'

export async function main(): Promise<never> {
  const config = loadConfig()
  const state = new ConnectorStateStore()
  let deviceToken = config.deviceToken
  let codex = detectCodexStatus(config.codexBinary, state)
  let claimInFlight: Promise<{ bound: boolean; already_bound: boolean }> | null = null

  const executor = new LocalCodexExecutor({
    binary: config.codexBinary,
    cwd: config.codexCwd,
    stateDir: config.stateDir,
    executionTimeoutMs: config.executionTimeoutMs,
  })
  const runner = new ExecutionRunner(executor, state)
  let connectorStarted = false
  const ensureConnector = () => {
    if (connectorStarted || !deviceToken) return
    connectorStarted = true
    void runConnector(config, () => deviceToken || '', runner, state)
  }

  const completeClaim = async (claimToken: string): Promise<{ bound: boolean; already_bound: boolean }> => {
    if (claimInFlight) return claimInFlight
    claimInFlight = (async () => {
      console.log('[helper] claim=received')
      const pairing = new PairingService(config.serverUrl)
      const paired = await pairing.complete({
        pairingToken: claimToken,
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        platform: config.platform,
        connectorVersion: config.connectorVersion,
      })
      deviceToken = paired.deviceCredential
      if (paired.connectorWsUrl && !config.connectorWsUrl) config.connectorWsUrl = paired.connectorWsUrl
      saveDevice(config, paired.deviceCredential, paired.connectorWsUrl)
      ensureConnector()
      console.log(`[helper] claim=${paired.alreadyBound ? 'already_bound' : 'bound'}`)
      return { bound: true, already_bound: paired.alreadyBound }
    })().finally(() => { claimInFlight = null })
    return claimInFlight
  }

  const helper = new LocalHelperServer({
    hostname: config.helperHost,
    port: config.helperPort,
    allowedOrigin: config.webOrigin,
    status: () => {
      const snapshot = state.snapshot()
      return {
        helper: 'online',
        bound: Boolean(deviceToken),
        server: snapshot.server === 'SERVER_CONNECTED' ? 'connected' : 'disconnected',
        device_id: config.deviceId,
        device_name: config.deviceName,
        platform: config.platform === 'darwin' ? 'macos' : config.platform,
        connector_version: config.connectorVersion,
        codex: {
          installed: codex.installed,
          logged_in: codex.loggedIn,
          status: codex.status,
        },
      }
    },
    claim: completeClaim,
  })
  helper.start()
  console.log(`[helper] status=online address=http://${helper.hostname}:${helper.port}`)

  if (codex.status === 'CODEX_READY') {
    void executor.warmup().catch(() => console.error('[codex] status=warmup_failed'))
  }
  ensureConnector()
  if (config.pairingToken) {
    try { await completeClaim(config.pairingToken) }
    catch (error: any) { console.error(`[helper] claim=failed code=${safeClaimCode(error?.message)}`) }
  }

  const codexTimer = setInterval(() => {
    codex = detectCodexStatus(config.codexBinary, state)
    if (codex.status === 'CODEX_READY') {
      void executor.warmup().catch(() => console.error('[codex] status=warmup_failed'))
    }
  }, 30_000)

  const shutdown = async () => {
    clearInterval(codexTimer)
    helper.stop()
    console.log('[connector] status=SERVER_DISCONNECTED reason=shutdown')
    await executor.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return new Promise<never>(() => {})
}

function safeClaimCode(message: string): string {
  if (message === 'DEVICE_ALREADY_BOUND_TO_ANOTHER_USER') return message
  if (/invalid|expired/i.test(message)) return 'CLAIM_TOKEN_INVALID_OR_EXPIRED'
  return 'CLAIM_FAILED'
}
