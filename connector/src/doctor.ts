import { lookup } from 'node:dns/promises'

const ENV_NAMES = [
  'HOME',
  'CODEX_HOME',
  'PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  elapsedMs: number
}

const binary = process.env.CODEX_BINARY_PATH || 'codex'
const codexEnv = { ...process.env }
let failed = false

function present(name: string): 'present' | 'absent' {
  return Object.prototype.hasOwnProperty.call(codexEnv, name) ? 'present' : 'absent'
}

async function run(command: string[], timeoutMs = 15_000): Promise<CommandResult> {
  const started = Date.now()
  let proc
  try {
    proc = Bun.spawn({
      cmd: command,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: codexEnv,
    })
  } catch {
    return { exitCode: null, stdout: '', stderr: '', timedOut: false, elapsedMs: Date.now() - started }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill('SIGKILL') } catch {}
  }, timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { exitCode, stdout, stderr, timedOut, elapsedMs: Date.now() - started }
}

console.log('[doctor] connector Codex diagnostics')

const version = await run([binary, '--version'])
if (version.exitCode === 0) {
  console.log('[doctor] codex_binary=present')
  console.log(`[doctor] codex_version=${version.stdout.trim().split(/\r?\n/, 1)[0] || 'unknown'}`)
} else {
  console.log('[doctor] codex_binary=absent')
  console.log('[doctor] codex_version=unavailable')
  failed = true
}

const login = await run([binary, 'login', 'status'])
if (login.exitCode === 0) {
  console.log('[doctor] codex_login=logged_in')
} else {
  console.log('[doctor] codex_login=not_logged_in')
  failed = true
}

console.log('[doctor] codex_spawn_environment')
for (const name of ENV_NAMES) console.log(`[env] ${name}=${present(name)}`)

for (const host of ['chatgpt.com', 'api.openai.com']) {
  try {
    const addresses = await lookup(host, { all: true })
    const ipv4 = addresses.filter((entry) => entry.family === 4).length
    const ipv6 = addresses.filter((entry) => entry.family === 6).length
    console.log(`[dns] ${host}=resolved ipv4=${ipv4} ipv6=${ipv6}`)
    if (addresses.length === 0) failed = true
  } catch {
    console.log(`[dns] ${host}=failed`)
    failed = true
  }
}

if (version.exitCode === 0 && login.exitCode === 0) {
  console.log('[doctor] codex_exec=running')
  const minimal = await run([binary, 'exec', '只回复 CONNECTOR_OK'], 180_000)
  if (!minimal.timedOut && minimal.exitCode === 0 && minimal.stdout.includes('CONNECTOR_OK')) {
    console.log(`[doctor] codex_exec=pass elapsed_ms=${minimal.elapsedMs}`)
  } else {
    const category = minimal.timedOut
      ? 'timeout'
      : /not logged in|authentication|unauthorized/i.test(minimal.stderr)
        ? 'auth'
        : /timed out|network|connect|dns/i.test(minimal.stderr)
          ? 'network'
          : 'other'
    console.log(`[doctor] codex_exec=fail category=${category} elapsed_ms=${minimal.elapsedMs}`)
    failed = true
  }
} else {
  console.log('[doctor] codex_exec=skipped')
}

process.exitCode = failed ? 1 : 0
