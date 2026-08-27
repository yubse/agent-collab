import { loadConfig, saveDevice } from './config/index.ts'
import { LocalCodexExecutor } from './codex/executor.ts'
import { CodexRuntimeManager } from './codex/runtime-manager.ts'
import { ExecutionRunner } from './execution/runner.ts'
import { runConnector } from './connection/client.ts'
import { PairingService } from './pairing/service.ts'
import { ConnectorStateStore } from './state/store.ts'
import { LocalHelperServer } from './helper/server.ts'

export async function main(): Promise<never> {
  const config = loadConfig()
  const state = new ConnectorStateStore()
  let deviceToken = config.deviceToken
  let claimInFlight: Promise<{ bound: boolean; already_bound: boolean }> | null = null

  const runtime = new CodexRuntimeManager(config, state)

  const executor = new LocalCodexExecutor({
    binary: config.managedCodexPath,
    cwd: config.codexCwd,
    stateDir: config.stateDir,
    executionTimeoutMs: config.executionTimeoutMs,
  }, undefined, runtime)
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
      const codex = runtime.snapshot()
      return {
        helper: 'online',
        device: { bound: Boolean(deviceToken), device_name: config.deviceName },
        server: { connected: snapshot.server === 'SERVER_CONNECTED' },
        platform: config.platform === 'darwin' ? 'macos' : config.platform,
        connector_version: config.connectorVersion,
        codex: {
          runtime_installed: codex.runtimeInstalled,
          runtime_version: codex.runtimeVersion,
          logged_in: codex.loggedIn,
          status: codex.status,
        },
      }
    },
    claim: completeClaim,
    codexLogin: () => runtime.login(),
    codexRestart: () => runtime.restart(),
  })
  helper.start()
  console.log(`[helper] status=online address=http://${helper.hostname}:${helper.port}`)

  void runtime.start().catch((error: any) => console.error(`[codex] status=prepare_failed code=${safeCodexCode(error?.message)}`))
  ensureConnector()
  if (config.pairingToken) {
    try { await completeClaim(config.pairingToken) }
    catch (error: any) { console.error(`[helper] claim=failed code=${safeClaimCode(error?.message)}`) }
  }

  const shutdown = async () => {
    helper.stop()
    console.log('[connector] status=SERVER_DISCONNECTED reason=shutdown')
    await executor.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return new Promise<never>(() => {})
}

function safeCodexCode(message: string): string {
  if (/NOT_INSTALLED|BUNDLED_RUNTIME/i.test(message)) return 'CODEX_RUNTIME_NOT_INSTALLED'
  if (/NOT_LOGGED_IN/i.test(message)) return 'CODEX_NOT_LOGGED_IN'
  return 'CODEX_RUNTIME_ERROR'
}

function safeClaimCode(message: string): string {
  if (message === 'DEVICE_ALREADY_BOUND_TO_ANOTHER_USER') return message
  if (/invalid|expired/i.test(message)) return 'CLAIM_TOKEN_INVALID_OR_EXPIRED'
  return 'CLAIM_FAILED'
}
