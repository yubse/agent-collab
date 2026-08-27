export type ConnectorTimeouts = {
  connectTimeoutMs: number
  requestAckTimeoutMs: number
  executionTimeoutMs: number
  serverPendingTimeoutMs: number
}

export const CONNECTOR_TIMEOUT_DEFAULTS: Readonly<ConnectorTimeouts> = {
  connectTimeoutMs: 15_000,
  requestAckTimeoutMs: 10_000,
  executionTimeoutMs: 300_000,
  serverPendingTimeoutMs: 330_000,
}

function positiveMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function loadConnectorTimeouts(
  env: Record<string, string | undefined> = process.env,
): ConnectorTimeouts {
  return {
    connectTimeoutMs: positiveMs(env.CONNECT_TIMEOUT_MS, CONNECTOR_TIMEOUT_DEFAULTS.connectTimeoutMs),
    requestAckTimeoutMs: positiveMs(env.REQUEST_ACK_TIMEOUT_MS, CONNECTOR_TIMEOUT_DEFAULTS.requestAckTimeoutMs),
    executionTimeoutMs: positiveMs(env.EXECUTION_TIMEOUT_MS, CONNECTOR_TIMEOUT_DEFAULTS.executionTimeoutMs),
    serverPendingTimeoutMs: positiveMs(env.SERVER_PENDING_TIMEOUT_MS, CONNECTOR_TIMEOUT_DEFAULTS.serverPendingTimeoutMs),
  }
}
