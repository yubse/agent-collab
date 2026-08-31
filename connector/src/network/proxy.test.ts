import { describe, expect, test } from 'bun:test'
import { formatProxyLog, resolveCodexProxyEnvironment } from './proxy.ts'

const SERVER_URL = 'http://192.168.20.200:3998'

describe('Codex proxy environment', () => {
  test('uses existing HTTP proxy environment before macOS settings', () => {
    const result = resolveCodexProxyEnvironment(SERVER_URL, {
      platform: 'darwin',
      env: { HTTPS_PROXY: 'http://env.proxy:8080', NO_PROXY: 'internal.example' },
      readMacOsProxy: () => macProxy({ HTTP: ['system.proxy', 3128] }),
    })

    expect(result.source).toBe('environment')
    expect(result.type).toBe('http')
    expect(result.environment.HTTP_PROXY).toBe('http://env.proxy:8080')
    expect(result.environment.HTTPS_PROXY).toBe('http://env.proxy:8080')
    expect(result.environment.ALL_PROXY).toBe('http://env.proxy:8080')
    expect(result.environment.NO_PROXY).toBe('internal.example,localhost,127.0.0.1,192.168.20.200')
  })

  test('reads active macOS HTTP and HTTPS proxies', () => {
    const result = resolveCodexProxyEnvironment(SERVER_URL, {
      platform: 'darwin',
      env: {},
      readMacOsProxy: () => macProxy({ HTTP: ['http.proxy', 8080], HTTPS: ['secure.proxy', 8443] }),
    })

    expect(result).toMatchObject({ source: 'macos', type: 'http' })
    expect(result.environment.HTTP_PROXY).toBe('http://http.proxy:8080')
    expect(result.environment.HTTPS_PROXY).toBe('http://secure.proxy:8443')
    expect(result.environment.ALL_PROXY).toBe('http://secure.proxy:8443')
  })

  test('maps an active macOS SOCKS proxy to all proxy variables', () => {
    const result = resolveCodexProxyEnvironment(SERVER_URL, {
      platform: 'darwin',
      env: {},
      readMacOsProxy: () => macProxy({ SOCKS: ['socks.proxy', 1080] }),
    })

    expect(result).toMatchObject({ source: 'macos', type: 'socks' })
    expect(result.environment.HTTP_PROXY).toBe('socks5h://socks.proxy:1080')
    expect(result.environment.HTTPS_PROXY).toBe('socks5h://socks.proxy:1080')
    expect(result.environment.ALL_PROXY).toBe('socks5h://socks.proxy:1080')
  })

  test('keeps direct mode when no proxy exists', () => {
    const result = resolveCodexProxyEnvironment(SERVER_URL, {
      platform: 'darwin',
      env: {},
      readMacOsProxy: () => '<dictionary> { HTTPEnable : 0 SOCKSEnable : 0 }',
    })

    expect(result).toMatchObject({ source: 'direct', type: 'direct' })
    expect(result.environment.HTTP_PROXY).toBeUndefined()
    expect(result.environment.NO_PROXY).toBe('localhost,127.0.0.1,192.168.20.200')
  })

  test('AI_STUDIO_PROXY_URL overrides environment and system proxies without logging credentials', () => {
    const result = resolveCodexProxyEnvironment(SERVER_URL, {
      platform: 'darwin',
      env: {
        AI_STUDIO_PROXY_URL: 'socks5h://user:secret@override.proxy:1080',
        HTTPS_PROXY: 'http://env.proxy:8080',
      },
      readMacOsProxy: () => macProxy({ HTTPS: ['system.proxy', 8443] }),
    })

    expect(result).toMatchObject({ source: 'ai_studio', type: 'socks' })
    expect(result.environment.ALL_PROXY).toBe('socks5h://user:secret@override.proxy:1080')
    expect(result.environment.HTTP_PROXY).toBe(result.environment.ALL_PROXY)
    expect(formatProxyLog(result)).toBe('[proxy] source=ai_studio type=socks')
    expect(formatProxyLog(result)).not.toContain('user')
    expect(formatProxyLog(result)).not.toContain('secret')
  })
})

function macProxy(values: Partial<Record<'HTTP' | 'HTTPS' | 'SOCKS', [string, number]>>): string {
  const lines = ['<dictionary> {']
  for (const prefix of ['HTTP', 'HTTPS', 'SOCKS'] as const) {
    const value = values[prefix]
    lines.push(`  ${prefix}Enable : ${value ? 1 : 0}`)
    if (value) {
      lines.push(`  ${prefix}Port : ${value[1]}`)
      lines.push(`  ${prefix}Proxy : ${value[0]}`)
    }
  }
  lines.push('}')
  return lines.join('\n')
}
