import { createHash, randomBytes } from 'crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { open, rename, unlink } from 'fs/promises'
import path from 'path'

export const DEFAULT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024
export const UPLOAD_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type StoredUpload = {
  filename: string
  originalName: string
  byteSize: number
  mimeType: string
  checksum: string
  assetType: 'generic' | 'audio'
  path: string
}

type UploadOptions = {
  uploadsDir: string
  originalName: string
  body: ReadableStream<Uint8Array> | null
  contentLength?: number | null
  maxBytes?: number
  signal?: AbortSignal
}

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'mp4'])

export function safeOriginalName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 255 || name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') {
    throw new Error('UPLOAD_FILENAME_INVALID')
  }
  return name
}

export function detectAudioSignature(header: Uint8Array, extension: string): string | null {
  const ascii = (start: number, length: number) => new TextDecoder('latin1').decode(header.slice(start, start + length))
  if (extension === 'wav' && header.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav'
  if (extension === 'mp3' && header.length >= 3) {
    if (ascii(0, 3) === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) return 'audio/mpeg'
  }
  if ((extension === 'm4a' || extension === 'mp4') && header.length >= 12 && ascii(4, 4) === 'ftyp') {
    return extension === 'm4a' ? 'audio/mp4' : 'video/mp4'
  }
  return null
}

function detectGenericMime(header: Uint8Array): string {
  const ascii = (start: number, length: number) => new TextDecoder('latin1').decode(header.slice(start, start + length))
  if (header.length >= 8 && header[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png'
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg'
  if (header.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
  if (header.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (header.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf'
  return 'application/octet-stream'
}

export async function streamUploadToDisk(options: UploadOptions): Promise<StoredUpload> {
  const originalName = safeOriginalName(options.originalName)
  if (!options.body) throw new Error('UPLOAD_BODY_REQUIRED')
  const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES
  if (options.contentLength !== null && options.contentLength !== undefined && options.contentLength > maxBytes) {
    throw new Error('UPLOAD_TOO_LARGE')
  }
  const extension = originalName.includes('.') ? originalName.split('.').pop()!.toLowerCase() : ''
  const isAudio = AUDIO_EXTENSIONS.has(extension)
  const tmpDir = path.join(options.uploadsDir, 'tmp')
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
  const nonce = randomBytes(18).toString('hex')
  const temporaryPath = path.join(tmpDir, `${nonce}.uploading`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  const hash = createHash('sha256')
  const headerParts: Uint8Array[] = []
  let headerSize = 0
  let byteSize = 0
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await handle.close().catch(() => {})
  }
  try {
    const reader = options.body.getReader()
    try {
      while (true) {
        if (options.signal?.aborted) throw new Error('UPLOAD_ABORTED')
        const { value, done } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        byteSize += value.byteLength
        if (byteSize > maxBytes) throw new Error('UPLOAD_TOO_LARGE')
        if (headerSize < 64) {
          const part = value.slice(0, Math.min(value.byteLength, 64 - headerSize))
          headerParts.push(part)
          headerSize += part.byteLength
        }
        hash.update(value)
        await handle.write(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
    if (byteSize === 0) throw new Error('UPLOAD_EMPTY')
    await handle.sync()
    await close()
    const header = new Uint8Array(headerSize)
    let offset = 0
    for (const part of headerParts) { header.set(part, offset); offset += part.byteLength }
    const audioMime = isAudio ? detectAudioSignature(header, extension) : null
    if (isAudio && !audioMime) throw new Error('UPLOAD_AUDIO_SIGNATURE_INVALID')
    const filename = `${Date.now()}-${randomBytes(9).toString('hex')}${extension ? `.${extension}` : ''}`
    const finalPath = path.join(options.uploadsDir, filename)
    await rename(temporaryPath, finalPath)
    return {
      filename,
      originalName,
      byteSize,
      mimeType: audioMime || detectGenericMime(header),
      checksum: hash.digest('hex'),
      assetType: isAudio ? 'audio' : 'generic',
      path: finalPath,
    }
  } catch (error) {
    await close()
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

export function cleanupStaleUploadTemps(uploadsDir: string, now = Date.now(), maxAgeMs = UPLOAD_TMP_MAX_AGE_MS): number {
  const tmpDir = path.join(uploadsDir, 'tmp')
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
  let removed = 0
  for (const name of readdirSync(tmpDir)) {
    if (!name.endsWith('.uploading')) continue
    const target = path.join(tmpDir, name)
    try {
      if (now - statSync(target).mtimeMs <= maxAgeMs) continue
      unlinkSync(target)
      removed += 1
    } catch {}
  }
  return removed
}
