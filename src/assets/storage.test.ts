import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { streamUploadToDisk } from './storage.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), 'aistudio-upload-'))
  roots.push(value)
  return value
}

function chunked(bytes: Uint8Array, size = 3): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  })
}

const fixtures = {
  mp3: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]),
  wav: new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 1]),
  m4a: new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 1]),
  mp4: new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1]),
}

describe('streaming asset storage', () => {
  for (const [extension, bytes] of Object.entries(fixtures)) {
    test(`accepts valid ${extension} by signature and computes checksum`, async () => {
      const uploadsDir = root()
      const result = await streamUploadToDisk({ uploadsDir, originalName: `meeting.${extension}`, body: chunked(bytes, 2) })
      expect(result.assetType).toBe('audio')
      expect(result.byteSize).toBe(bytes.byteLength)
      expect(result.checksum).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(result.filename).not.toContain('meeting')
      expect(readdirSync(path.join(uploadsDir, 'tmp'))).toEqual([])
    })
  }

  test('rejects a forged audio extension and removes its temp file', async () => {
    const uploadsDir = root()
    await expect(streamUploadToDisk({
      uploadsDir, originalName: 'fake.mp3', body: chunked(new TextEncoder().encode('not audio')),
    })).rejects.toThrow('UPLOAD_AUDIO_SIGNATURE_INVALID')
    expect(readdirSync(path.join(uploadsDir, 'tmp'))).toEqual([])
  })

  test('enforces the limit while streaming without buffering the complete body', async () => {
    const uploadsDir = root()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(8))
        if (pulls > 10) controller.close()
      },
    })
    await expect(streamUploadToDisk({ uploadsDir, originalName: 'large.bin', body, maxBytes: 12 }))
      .rejects.toThrow('UPLOAD_TOO_LARGE')
    expect(pulls).toBeLessThan(10)
    expect(readdirSync(path.join(uploadsDir, 'tmp'))).toEqual([])
  })

  test('rejects path traversal before opening a temp file', async () => {
    const uploadsDir = root()
    await expect(streamUploadToDisk({ uploadsDir, originalName: '../meeting.mp3', body: chunked(fixtures.mp3) }))
      .rejects.toThrow('UPLOAD_FILENAME_INVALID')
  })

  test('cleans the temp file when the client aborts mid-stream', async () => {
    const uploadsDir = root()
    const abort = new AbortController()
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(fixtures.mp3.slice(0, 4))
          abort.abort()
        }
      },
    })
    await expect(streamUploadToDisk({ uploadsDir, originalName: 'aborted.mp3', body, signal: abort.signal }))
      .rejects.toThrow('UPLOAD_ABORTED')
    expect(readdirSync(path.join(uploadsDir, 'tmp'))).toEqual([])
  })
})
