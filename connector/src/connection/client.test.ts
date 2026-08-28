import { describe, expect, test } from 'bun:test'
import type { ConnectorConfig } from '../config/index.ts'
import { ExecutionRunner } from '../execution/runner.ts'
import { ConnectorStateStore } from '../state/store.ts'
import { connectOnce } from './client.ts'

function config(port: number, connectTimeoutMs = 1_000): ConnectorConfig {
  return {
    serverUrl: `http://127.0.0.1:${port}`,
    connectorWsUrl: `ws://127.0.0.1:${port}/connector`,
    deviceName: 'test connector',
    deviceId: 'dev_test-connector',
    platform: 'darwin',
    connectorVersion: '0.1.0',
    webOrigin: `http://127.0.0.1:${port}`,
    helperHost: '127.0.0.1',
    helperPort: 39481,
    deviceToken: 'test-token',
    pairingToken: null,
    codexBinary: 'codex',
    codexCwd: process.cwd(),
    codexHome: '/tmp/connector-client-test-codex-home',
    appSupportDir: '/tmp/connector-client-test-support',
    managedCodexPath: '/tmp/connector-client-test-runtime/codex',
    bundledCodexPath: null,
    useSystemCodex: true,
    stateDir: '/tmp/connector-client-test',
    connectTimeoutMs,
    executionTimeoutMs: 300_000,
    codexWorkerCount: 3,
  }
}

describe('Connector WebSocket execution lifecycle', () => {
  test('ACKs immediately, keeps heartbeat alive, and executes duplicate request_id once', async () => {
    const observed: string[] = []
    let modelCalls = 0
    const server = Bun.serve({
      port: 0,
      fetch(req, bunServer) {
        if (bunServer.upgrade(req)) return undefined
        return new Response('upgrade required', { status: 426 })
      },
      websocket: {
        message(ws, data) {
          const message = JSON.parse(String(data))
          observed.push(message.type)
          if (message.type === 'hello') {
            ws.send(JSON.stringify({ type: 'hello_ack', status: 'ok', heartbeat_interval: 1 }))
            const request = {
              type: 'execution_request', request_id: 'req_once', user_id: 'user-a',
              conversation_id: 'conv-a', agent_id: 'social', prompt: 'not logged',
              created_at: new Date().toISOString(),
            }
            ws.send(JSON.stringify(request))
            ws.send(JSON.stringify(request))
          }
          if (message.type === 'execution_result') ws.close()
        },
      },
    })
    const runner = new ExecutionRunner({
      execute: async () => {
        modelCalls += 1
        await Bun.sleep(1_200)
        return { content: 'CONNECTOR_OK', usage: null }
      },
    }, new ConnectorStateStore(), () => {})

    try {
      await connectOnce(config(server.port), 'test-token', runner, new ConnectorStateStore())
      expect(observed.filter((type) => type === 'execution_ack')).toHaveLength(2)
      expect(observed.filter((type) => type === 'heartbeat').length).toBeGreaterThanOrEqual(1)
      expect(observed.filter((type) => type === 'execution_result')).toHaveLength(1)
      expect(observed.indexOf('execution_ack')).toBeLessThan(observed.indexOf('execution_result'))
      expect(modelCalls).toBe(1)
    } finally {
      server.stop(true)
    }
  }, 5_000)

  test('uses an independent connection timeout', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, bunServer) {
        if (bunServer.upgrade(req)) return undefined
        return new Response('upgrade required', { status: 426 })
      },
      websocket: { message() {} },
    })
    try {
      const runner = new ExecutionRunner({ execute: async () => ({ content: '', usage: null }) }, new ConnectorStateStore(), () => {})
      await expect(connectOnce(config(server.port, 30), 'test-token', runner, new ConnectorStateStore())).rejects.toThrow('CONNECT_TIMEOUT')
    } finally {
      server.stop(true)
    }
  })
})
