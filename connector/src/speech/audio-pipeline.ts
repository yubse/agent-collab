import { existsSync, mkdirSync } from 'fs'
import { open, unlink } from 'fs/promises'
import path from 'path'
import { randomBytes } from 'crypto'
import { SpeechProviderError } from './provider.ts'

export const SENSEVOICE_MAX_SEGMENT_MS = 25_000
export const SENSEVOICE_SEGMENT_OVERLAP_MS = 1_000
export type PreparedAudioSegment = { wavPath: string; sourceStartMs: number; sourceEndMs: number; durationMs: number }
export type PreparedAudio = { wavPath: string; durationMs: number; segments: PreparedAudioSegment[]; cleanup: () => Promise<void> }

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
    let segments: PreparedAudioSegment[]
    try { segments = await splitPcmWav(wavPath, this.workDir, SENSEVOICE_MAX_SEGMENT_MS, signal) }
    catch (error) { await unlink(wavPath).catch(() => {}); throw error }
    return {
      wavPath,
      durationMs,
      segments,
      cleanup: async () => {
        await Promise.all(segments.filter((segment) => segment.wavPath !== wavPath).map((segment) => unlink(segment.wavPath).catch(() => {})))
        await unlink(wavPath).catch(() => {})
      },
    }
  }
}

export async function splitPcmWav(filename: string, workDir: string, maxSegmentMs = SENSEVOICE_MAX_SEGMENT_MS, signal?: AbortSignal, overlapMs = SENSEVOICE_SEGMENT_OVERLAP_MS): Promise<PreparedAudioSegment[]> {
  const info = await inspectPcmWav(filename)
  const maxDataBytes = Math.max(info.blockAlign, Math.floor(info.byteRate * maxSegmentMs / 1000 / info.blockAlign) * info.blockAlign)
  const overlapBytes = Math.min(maxDataBytes - info.blockAlign, Math.max(0, Math.floor(info.byteRate * overlapMs / 1000 / info.blockAlign) * info.blockAlign))
  if (info.dataSize <= maxDataBytes) return [{ wavPath: filename, sourceStartMs: 0, sourceEndMs: info.durationMs, durationMs: info.durationMs }]
  const source = await open(filename, 'r')
  const segments: PreparedAudioSegment[] = []
  try {
    let offset = 0
    while (offset < info.dataSize) {
      if (signal?.aborted) throw new SpeechProviderError('SPEECH_CANCELLED')
      const length = Math.min(maxDataBytes, info.dataSize - offset)
      const segmentPath = path.join(workDir, `${randomBytes(20).toString('hex')}.segment.wav`)
      const destination = await open(segmentPath, 'wx', 0o600)
      try {
        await destination.write(wavHeader(length, info.sampleRate, info.channels, info.bitsPerSample))
        const buffer = new Uint8Array(Math.min(256 * 1024, length))
        let copied = 0
        while (copied < length) {
          if (signal?.aborted) throw new SpeechProviderError('SPEECH_CANCELLED')
          const wanted = Math.min(buffer.byteLength, length - copied)
          const { bytesRead } = await source.read(buffer, 0, wanted, info.dataOffset + offset + copied)
          if (!bytesRead) throw new SpeechProviderError('SPEECH_TRANSCODE_FAILED')
          await destination.write(buffer.subarray(0, bytesRead))
          copied += bytesRead
        }
      } catch (error) {
        await destination.close().catch(() => {})
        await unlink(segmentPath).catch(() => {})
        throw error
      }
      await destination.close()
      const sourceStartMs = Math.round(offset / info.byteRate * 1000)
      const sourceEndMs = Math.min(info.durationMs, Math.round((offset + length) / info.byteRate * 1000))
      segments.push({ wavPath: segmentPath, sourceStartMs, sourceEndMs, durationMs: sourceEndMs - sourceStartMs })
      offset += length === info.dataSize - offset ? length : length - overlapBytes
    }
    return segments
  } catch (error) {
    await Promise.all(segments.map((segment) => unlink(segment.wavPath).catch(() => {})))
    throw error
  } finally { await source.close() }
}

async function inspectPcmWav(filename: string) {
  const bytes = new Uint8Array(await Bun.file(filename).slice(0, 64 * 1024).arrayBuffer())
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' || new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WAVE') throw new SpeechProviderError('SPEECH_TRANSCODE_FAILED')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12, channels = 0, sampleRate = 0, byteRate = 0, blockAlign = 0, bitsPerSample = 0, dataOffset = 0, dataSize = 0
  while (offset + 8 <= bytes.length) {
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    if (name === 'fmt ' && offset + 8 + size <= bytes.length) {
      const format = view.getUint16(offset + 8, true)
      const extensiblePcm = format === 0xfffe && size >= 40 && view.getUint32(offset + 32, true) === 1
      if (format !== 1 && !extensiblePcm) throw new SpeechProviderError('SPEECH_TRANSCODE_FAILED')
      channels = view.getUint16(offset + 10, true); sampleRate = view.getUint32(offset + 12, true)
      byteRate = view.getUint32(offset + 16, true); blockAlign = view.getUint16(offset + 20, true); bitsPerSample = view.getUint16(offset + 22, true)
    }
    if (name === 'data') { dataOffset = offset + 8; dataSize = size; break }
    offset += 8 + size + (size % 2)
  }
  if (!channels || !sampleRate || !byteRate || !blockAlign || !bitsPerSample || !dataOffset || !dataSize) throw new SpeechProviderError('SPEECH_TRANSCODE_FAILED')
  return { channels, sampleRate, byteRate, blockAlign, bitsPerSample, dataOffset, dataSize, durationMs: Math.round(dataSize / byteRate * 1000) }
}

function wavHeader(dataSize: number, sampleRate: number, channels: number, bitsPerSample: number) {
  const header = new Uint8Array(44), view = new DataView(header.buffer), text = new TextEncoder()
  header.set(text.encode('RIFF'), 0); view.setUint32(4, 36 + dataSize, true); header.set(text.encode('WAVEfmt '), 8)
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true)
  const blockAlign = channels * bitsPerSample / 8
  view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, bitsPerSample, true)
  header.set(text.encode('data'), 36); view.setUint32(40, dataSize, true)
  return header
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
