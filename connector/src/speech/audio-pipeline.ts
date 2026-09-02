import { existsSync, mkdirSync } from 'fs'
import { unlink } from 'fs/promises'
import path from 'path'
import { randomBytes } from 'crypto'
import { SpeechProviderError } from './provider.ts'

export type PreparedAudio = { wavPath: string; durationMs: number; cleanup: () => Promise<void> }

export class AudioPipeline {
  constructor(private readonly workDir: string, private readonly afconvert = '/usr/bin/afconvert') {
    mkdirSync(workDir, { recursive: true, mode: 0o700 })
  }

  async prepare(inputPath: string, originalName: string, signal: AbortSignal): Promise<PreparedAudio> {
    if (!existsSync(this.afconvert)) throw new SpeechProviderError('SPEECH_TRANSCODE_FAILED', 'managed CoreAudio converter unavailable')
    const extension = path.extname(originalName).slice(1).toLowerCase()
    if (!['wav', 'mp3', 'm4a', 'mp4'].includes(extension)) throw new SpeechProviderError('SPEECH_UNSUPPORTED_FORMAT')
    const wavPath = path.join(this.workDir, `${randomBytes(20).toString('hex')}.16k.wav`)
    const child = Bun.spawn([this.afconvert, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', inputPath, wavPath], { stdout: 'ignore', stderr: 'pipe' })
    const abort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', abort, { once: true })
    const code = await child.exited
    signal.removeEventListener('abort', abort)
    if (signal.aborted) { await unlink(wavPath).catch(() => {}); throw new SpeechProviderError('SPEECH_CANCELLED') }
    if (code !== 0) { await unlink(wavPath).catch(() => {}); throw new SpeechProviderError('SPEECH_TRANSCODE_FAILED') }
    const durationMs = await wavDurationMs(wavPath)
    return { wavPath, durationMs, cleanup: () => unlink(wavPath).catch(() => {}) }
  }
}

export async function wavDurationMs(filename: string): Promise<number> {
  const bytes = new Uint8Array(await Bun.file(filename).slice(0, 8192).arrayBuffer())
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF') throw new SpeechProviderError('SPEECH_TRANSCODE_FAILED')
  let offset = 12, sampleRate = 0, byteRate = 0, dataSize = 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (offset + 8 <= bytes.length) {
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    if (name === 'fmt ' && offset + 16 <= bytes.length) { sampleRate = view.getUint32(offset + 12, true); byteRate = view.getUint32(offset + 16, true) }
    if (name === 'data') { dataSize = size; break }
    offset += 8 + size + (size % 2)
  }
  if (!sampleRate || !byteRate || !dataSize) {
    const stat = await Bun.file(filename).stat()
    dataSize = Math.max(0, stat.size - 44); byteRate = 32_000
  }
  return Math.round(dataSize / byteRate * 1000)
}
