export type ProxySource = 'ai_studio' | 'environment' | 'macos' | 'direct'
export type ProxyType = 'http' | 'socks' | 'mixed' | 'direct'

export type ResolvedProxyEnvironment = {
  source: ProxySource
  type: ProxyType
  environment: Record<string, string>
}

type ResolveProxyOptions = {
  env?: Record<string, string | undefined>
  platform?: string
  readMacOsProxy?: () => string | null
}

type ProxyUrls = {
  http?: string
  https?: string
  all?: string
}

const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'])

export function resolveCodexProxyEnvironment(
  serverUrl: string,
  options: ResolveProxyOptions = {},
): ResolvedProxyEnvironment {
  const env = options.env || process.env
  const noProxy = mergeNoProxy(env.NO_PROXY || env.no_proxy, serverHost(serverUrl))
  const override = env.AI_STUDIO_PROXY_URL?.trim()

  if (override) {
    const proxyUrl = normalizeExplicitProxyUrl(override)
    return resolved('ai_studio', { http: proxyUrl, https: proxyUrl, all: proxyUrl }, noProxy)
  }

  const environmentProxy = existingProxyEnvironment(env)
  if (environmentProxy) return resolved('environment', environmentProxy, noProxy)

  const platform = options.platform || process.platform
  if (platform === 'darwin') {
    const output = (options.readMacOsProxy || readMacOsSystemProxy)()
    const systemProxy = output ? parseMacOsSystemProxy(output) : null
    if (systemProxy) return resolved('macos', systemProxy, noProxy)
  }

  return {
    source: 'direct',
    type: 'direct',
    environment: noProxy ? { NO_PROXY: noProxy, no_proxy: noProxy } : {},
  }
}

export function formatProxyLog(resolution: ResolvedProxyEnvironment): string {
  return `[proxy] source=${resolution.source} type=${resolution.type}`
}

export function parseMacOsSystemProxy(output: string): ProxyUrls | null {
  const http = enabledSystemProxy(output, 'HTTP')
  const https = enabledSystemProxy(output, 'HTTPS')
  const socks = enabledSystemProxy(output, 'SOCKS', 'socks5h')
  if (!http && !https && !socks) return null
  return {
    http: http || https || socks,
    https: https || http || socks,
    all: socks || https || http,
  }
}

function readMacOsSystemProxy(): string | null {
  try {
    const result = Bun.spawnSync(['/usr/sbin/scutil', '--proxy'], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env },
    })
    if (result.exitCode !== 0) return null
    return new TextDecoder().decode(result.stdout)
  } catch {
    return null
  }
}

function existingProxyEnvironment(env: Record<string, string | undefined>): ProxyUrls | null {
  const http = firstValue(env.HTTP_PROXY, env.http_proxy)
  const https = firstValue(env.HTTPS_PROXY, env.https_proxy)
  const all = firstValue(env.ALL_PROXY, env.all_proxy)
  if (!http && !https && !all) return null
  return {
    http: http || https || all,
    https: https || http || all,
    all: all || https || http,
  }
}

function enabledSystemProxy(output: string, prefix: 'HTTP' | 'HTTPS' | 'SOCKS', scheme = 'http'): string | undefined {
  if (dictionaryValue(output, `${prefix}Enable`) !== '1') return undefined
  const host = dictionaryValue(output, `${prefix}Proxy`)
  const port = Number.parseInt(dictionaryValue(output, `${prefix}Port`) || '', 10)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${scheme}://${formattedHost}:${port}`
}

function dictionaryValue(output: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^\\r\\n]+)`))
  return match?.[1]?.trim() || undefined
}

function normalizeExplicitProxyUrl(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) }
  catch { throw new Error('AI_STUDIO_PROXY_URL must be a valid proxy URL') }
  if (!PROXY_SCHEMES.has(parsed.protocol) || !parsed.hostname) {
    throw new Error('AI_STUDIO_PROXY_URL uses an unsupported proxy scheme')
  }
  return value
}

function resolved(source: Exclude<ProxySource, 'direct'>, urls: ProxyUrls, noProxy: string): ResolvedProxyEnvironment {
  const http = urls.http || urls.https || urls.all
  const https = urls.https || urls.http || urls.all
  const all = urls.all || urls.https || urls.http
  if (!http || !https || !all) return { source: 'direct', type: 'direct', environment: {} }
  const environment = {
    HTTP_PROXY: http,
    HTTPS_PROXY: https,
    ALL_PROXY: all,
    NO_PROXY: noProxy,
    http_proxy: http,
    https_proxy: https,
    all_proxy: all,
    no_proxy: noProxy,
  }
  return { source, type: proxyType([http, https, all]), environment }
}

function proxyType(urls: string[]): ProxyType {
  const types = new Set(urls.map((value) => /^socks/i.test(value) ? 'socks' : 'http'))
  return types.size > 1 ? 'mixed' : types.has('socks') ? 'socks' : 'http'
}

function mergeNoProxy(current: string | undefined, nasHost: string | null): string {
  const entries = [
    ...(current || '').split(','),
    'localhost',
    '127.0.0.1',
    ...(nasHost ? [nasHost] : []),
  ].map((value) => value.trim()).filter(Boolean)
  const seen = new Set<string>()
  return entries.filter((value) => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).join(',')
}

function serverHost(serverUrl: string): string | null {
  try { return new URL(serverUrl).hostname || null }
  catch { return null }
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean)
}
