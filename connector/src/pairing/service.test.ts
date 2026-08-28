import { describe, expect, test } from 'bun:test'
import { PairingService, pairingTokenFromLaunchArgs, safeConnectorWebsocketUrl } from './service.ts'

describe('PairingService', () => {
  test('parses CLI and future Tauri deep-link inputs', () => {
    expect(pairingTokenFromLaunchArgs(['--pair-token', 'token_from_cli'])).toBe('token_from_cli')
    expect(pairingTokenFromLaunchArgs(['--pair-token=token_inline'])).toBe('token_inline')
    expect(pairingTokenFromLaunchArgs(['aistudio://pair?token=token_from_deep_link'])).toBe('token_from_deep_link')
    expect(pairingTokenFromLaunchArgs(['aistudio://other?token=nope'])).toBeNull()
  })

  test('automatically completes pairing without sending a user identity', async () => {
    const requests: Array<{ pathname: string; body: any; requestId: string | null }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const body = await request.json() as any
        requests.push({ pathname: url.pathname, body, requestId: request.headers.get('x-aistudio-claim-request-id') })
        return Response.json({
          ok: true,
          already_bound: false,
          device_credential: 'device-credential-only-after-confirm',
          websocket_url: `http://127.0.0.1:${server.port}/connector`,
        }, { status: 201 })
      },
    })
    try {
      const pairing = new PairingService(`http://127.0.0.1:${server.port}`)
      const confirmed = await pairing.complete({
        pairingToken: 'secret-pairing-token',
        deviceId: 'dev_local-installation',
        deviceName: 'Liu Ting Mac',
        platform: 'darwin',
        connectorVersion: '0.1.0',
        requestId: 'claim_trace_1',
      })
      expect(confirmed.deviceCredential).toBe('device-credential-only-after-confirm')
      expect(confirmed.connectorWsUrl).toBe(`ws://127.0.0.1:${server.port}/connector`)
      expect(confirmed.alreadyBound).toBe(false)
      expect(requests).toEqual([
        {
          pathname: '/api/connectors/claim/complete',
          requestId: 'claim_trace_1',
          body: {
            claim_token: 'secret-pairing-token',
            device_id: 'dev_local-installation',
            device_name: 'Liu Ting Mac',
            platform: 'darwin',
            connector_version: '0.1.0',
          },
        },
      ])
    } finally {
      server.stop(true)
    }
  })

  test('ignores an advertised websocket URL with the wrong port', () => {
    expect(safeConnectorWebsocketUrl(
      'http://192.168.20.200:3998',
      'ws://192.168.20.200/connector',
    )).toBe('ws://192.168.20.200:3998/connector')
  })
})
