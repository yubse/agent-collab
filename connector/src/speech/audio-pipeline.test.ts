import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { splitPcmWav } from './audio-pipeline.ts'

function pcmWav(durationMs: number) {
  const sampleRate = 16_000, channels = 1, bits = 16
  const dataSize = Math.floor(sampleRate * channels * bits / 8 * durationMs / 1000)
  const bytes = new Uint8Array(44 + dataSize), view = new DataView(bytes.buffer), encoder = new TextEncoder()
  bytes.set(encoder.encode('RIFF'), 0); view.setUint32(4, 36 + dataSize, true); bytes.set(encoder.encode('WAVEfmt '), 8)
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, bits, true)
  bytes.set(encoder.encode('data'), 36); view.setUint32(40, dataSize, true)
  return bytes
}

describe('SenseVoice bounded audio segments', () => {
  test('splits canonical PCM into segments no longer than 25 seconds', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'speech-segments-'))
    const input = path.join(dir, 'long.wav')
    writeFileSync(input, pcmWav(61_000))
    const segments = await splitPcmWav(input, dir, 25_000)
    expect(segments).toHaveLength(3)
    expect(segments.map((segment) => segment.durationMs)).toEqual([25_000, 25_000, 13_000])
    expect(segments.map((segment) => segment.sourceStartMs)).toEqual([0, 24_000, 48_000])
    expect(Math.max(...segments.map((segment) => segment.durationMs))).toBeLessThanOrEqual(25_000)
    expect(segments.at(-1)?.sourceEndMs).toBe(61_000)
  })
})
