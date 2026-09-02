import { createHash, randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync } from 'fs'
import { open, rename, unlink } from 'fs/promises'
import path from 'path'
import { SpeechProviderError } from './provider.ts'

export type ModelArtifact = { filename: string; url: string; sha256: string }
export type ModelInstallState = 'not_installed' | 'downloading' | 'verifying' | 'ready' | 'error'

export class ModelManager {
  state: ModelInstallState = 'not_installed'
  private installs = new Map<string, Promise<string>>()

  constructor(
    readonly modelsDir: string,
    private readonly downloadEnv: Record<string, string> = {},
    private readonly downloader = downloadWithCurl,
  ) {
    mkdirSync(modelsDir, { recursive: true, mode: 0o700 })
    chmodSync(modelsDir, 0o700)
  }

  async ensure(artifact: ModelArtifact, signal?: AbortSignal): Promise<string> {
    const destination = path.join(this.modelsDir, artifact.filename)
    if (await checksumMatches(destination, artifact.sha256)) { this.state = 'ready'; return destination }
    const existing = this.installs.get(artifact.filename)
    if (existing) return existing
    const install = this.install(artifact, destination, signal).finally(() => this.installs.delete(artifact.filename))
    this.installs.set(artifact.filename, install)
    return install
  }

  private async install(artifact: ModelArtifact, destination: string, signal?: AbortSignal) {
    const temporary = path.join(this.modelsDir, `.${artifact.filename}.${randomBytes(8).toString('hex')}.downloading`)
    try {
      this.state = 'downloading'
      await this.downloader(artifact.url, temporary, { ...process.env, ...this.downloadEnv }, signal)
      this.state = 'verifying'
      if (!await checksumMatches(temporary, artifact.sha256)) throw new SpeechProviderError('SPEECH_MODEL_CHECKSUM_FAILED')
      await rename(temporary, destination)
      chmodSync(destination, 0o600)
      this.state = 'ready'
      return destination
    } catch (error: any) {
      this.state = 'error'
      await unlink(temporary).catch(() => {})
      if (error instanceof SpeechProviderError) throw error
      if (signal?.aborted) throw new SpeechProviderError('SPEECH_CANCELLED')
      throw new SpeechProviderError('SPEECH_MODEL_DOWNLOAD_FAILED', String(error?.message || error))
    }
  }
}

export async function sha256File(filename: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = Bun.file(filename).stream().getReader()
  while (true) {
    const { value, done } = await stream.read()
    if (done) break
    if (value) hash.update(value)
  }
  return hash.digest('hex')
}

async function checksumMatches(filename: string, expected: string) {
  if (!existsSync(filename) || !/^[a-f0-9]{64}$/.test(expected)) return false
  return (await sha256File(filename)) === expected
}

async function downloadWithCurl(url: string, destination: string, env: Record<string, string>, signal?: AbortSignal) {
  const process = Bun.spawn(['/usr/bin/curl', '--fail', '--location', '--retry', '2', '--output', destination, url], {
    stdout: 'ignore', stderr: 'pipe', env,
  })
  const abort = () => process.kill('SIGTERM')
  signal?.addEventListener('abort', abort, { once: true })
  const exitCode = await process.exited
  signal?.removeEventListener('abort', abort)
  if (exitCode !== 0) throw new Error(`curl exited ${exitCode}`)
}
