import { clearDeviceCredential, loadConfig, saveDevice } from './config/index.ts'
import { LocalCodexExecutor } from './codex/executor.ts'
import { CodexRuntimeManager } from './codex/runtime-manager.ts'
import { PURE_CHAT_APP_SERVER_ARGS } from './codex/options.ts'
import { CodexProvider } from '../../src/providers/codex.ts'
import { ExecutionRunner } from './execution/runner.ts'
import { runConnector } from './connection/client.ts'
import { PairingService } from './pairing/service.ts'
import { ConnectorStateStore } from './state/store.ts'
import { LocalHelperServer } from './helper/server.ts'
import { formatProxyLog } from './network/proxy.ts'

export async function main(): Promise<never> {
  const config = loadConfig()
  console.log(formatProxyLog({
    source: config.codexProxySource,
    type: config.codexProxyType,
    environment: config.codexProxyEnvironment,
  }))
  const state = new ConnectorStateStore()
  let deviceToken = config.deviceToken
  let claimInFlight: Promise<{ bound: boolean; already_bound: boolean }> | null = null

  const runtime = new CodexRuntimeManager(config, state)

  const codexBinary = config.useSystemCodex ? config.codexBinary : config.managedCodexPath
  const providers = [
    runtime,
    ...Array.from({ length: config.codexWorkerCount - 1 }, (_, index) => new CodexProvider({
      label: `connector:managed-app-server-worker-${index + 2}`,
      binaryPath: codexBinary,
      cwd: config.codexCwd,
      env: { ...config.codexProxyEnvironment, CODEX_HOME: config.codexHome },
      extraArgs: [...PURE_CHAT_APP_SERVER_ARGS],
      onDiagnostic: (event) => {
        if (event.stream === 'process') console.error(`[codex] worker=${index + 2} status=exited code=${event.exitCode ?? 'unknown'}`)
        else console.error(`[codex] worker=${index + 2} status=diagnostic`)
      },
    })),
  ]

  const executor = new LocalCodexExecutor({
    binary: config.managedCodexPath,
    cwd: config.codexCwd,
    stateDir: config.stateDir,
    executionTimeoutMs: config.executionTimeoutMs,
  }, undefined, providers)
  console.log(`[codex] worker_pool=${executor.workerCount}`)
  const runner = new ExecutionRunner(executor, state)
  let connectorController: AbortController | null = null
  const ensureConnector = () => {
    if (connectorController || !deviceToken) return
    const controller = new AbortController()
    connectorController = controller
    void runConnector(config, () => deviceToken || '', runner, state, controller.signal)
      .finally(() => { if (connectorController === controller) connectorController = null })
  }

  const stopConnector = () => {
    const controller = connectorController
    connectorController = null
    controller?.abort()
    state.setServer('SERVER_DISCONNECTED')
  }

  const completeClaim = async (claimToken: string, incomingRequestId: string | null = null): Promise<{ bound: boolean; already_bound: boolean }> => {
    if (claimInFlight) return claimInFlight
    const requestId = safeTraceId(incomingRequestId) || `claim_${Date.now()}`
    claimInFlight = (async () => {
      console.log(`[connector-claim] request=${requestId} stage=helper_received`)
      const pairing = new PairingService(config.serverUrl)
      console.log(`[connector-claim] request=${requestId} stage=server_submit_started`)
      const paired = await pairing.complete({
        pairingToken: claimToken,
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        platform: config.platform,
        connectorVersion: config.connectorVersion,
        requestId,
      })
      deviceToken = paired.deviceCredential
      if (paired.connectorWsUrl && !config.connectorWsUrl) config.connectorWsUrl = paired.connectorWsUrl
      try {
        saveDevice(config, paired.deviceCredential, paired.connectorWsUrl)
      } catch {
        console.error(`[connector-claim] request=${requestId} stage=credential_save_failed`)
        throw new Error('DEVICE_CREDENTIAL_SAVE_FAILED')
      }
      console.log(`[connector-claim] request=${requestId} stage=credential_saved`)
      ensureConnector()
      console.log(`[connector-claim] request=${requestId} stage=websocket_starting`)
      console.log(`[connector-claim] request=${requestId} stage=${paired.alreadyBound ? 'already_bound' : 'device_bound'}`)
      return { bound: true, already_bound: paired.alreadyBound }
    })().catch((error) => {
      console.error(`[connector-claim] request=${requestId} stage=failed code=${safeClaimCode(error?.message)}`)
      throw error
    }).finally(() => { claimInFlight = null })
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
        device: { bound: Boolean(deviceToken), device_id: config.deviceId, device_name: config.deviceName },
        server: {
          connected: snapshot.server === 'SERVER_CONNECTED',
          error_code: safeServerErrorCode(snapshot.serverError),
        },
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
    unbind: async (deviceId) => {
      if (deviceId !== config.deviceId) throw new Error('device_id mismatch')
      stopConnector()
      try {
        clearDeviceCredential(config)
      } catch {
        throw new Error('DEVICE_CREDENTIAL_CLEAR_FAILED')
      }
      deviceToken = null
      config.deviceToken = null
      console.log(`[connector-unbind] device=${safeTraceId(config.deviceId) || 'unknown'} state=credential_cleared`)
      return { unbound: true }
    },
    codexLogin: () => runtime.login(),
    codexRestart: () => runtime.restart(),
  })
  helper.start()
  console.log(`[helper] status=online address=http://${helper.hostname}:${helper.port}`)

  void executor.warmup().catch((error: any) => console.error(`[codex] status=prepare_failed code=${safeCodexCode(error?.message)}`))
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

function safeTraceId(value: string | null): string | null {
  const id = String(value || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100)
  return id || null
}

function safeServerErrorCode(message: string | null): string | null {
  if (!message) return null
  if (/authentication|device token|before authentication/i.test(message)) return 'WEBSOCKET_AUTH_FAILED'
  return 'SERVER_CONNECTION_FAILED'
}
