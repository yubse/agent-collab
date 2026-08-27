import { loadConfig, saveDevice } from './config/index.ts'
import { checkCodex } from './codex/preflight.ts'
import { LocalCodexExecutor } from './codex/executor.ts'
import { ExecutionRunner } from './execution/runner.ts'
import { runConnector } from './connection/client.ts'
import { pairDevice } from './pairing/client.ts'
import { ConnectorStateStore } from './state/store.ts'

export async function main(): Promise<never> {
  const config = loadConfig()
  const state = new ConnectorStateStore()
  const preflight = checkCodex(config.codexBinary, state)
  console.log(`[connector] status=CODEX_READY version="${preflight.version}"`)

  let deviceToken = config.deviceToken
  if (!deviceToken) {
    const pairingCode = config.pairingCode || prompt('请输入网页 Settings → Devices 中显示的 6 位配对码：')?.trim()
    if (!pairingCode) throw new Error('pairing code required')
    const paired = await pairDevice(config.serverUrl, config.deviceName, pairingCode)
    deviceToken = paired.deviceToken
    if (paired.connectorWsUrl && !config.connectorWsUrl) config.connectorWsUrl = paired.connectorWsUrl
    saveDevice(config, deviceToken, paired.connectorWsUrl)
    console.log('[connector] device paired; secret stored only on this computer')
  }

  const executor = new LocalCodexExecutor({
    binary: config.codexBinary,
    cwd: config.codexCwd,
    stateDir: config.stateDir,
    executionTimeoutMs: config.executionTimeoutMs,
  })
  const runner = new ExecutionRunner(executor, state)
  const shutdown = async () => {
    console.log('[connector] status=SERVER_DISCONNECTED reason=shutdown')
    await executor.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return runConnector(config, deviceToken, runner, state)
}
