import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { SenseVoiceProvider } from './sensevoice-provider.ts'

function fixture(scriptBody: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sensevoice-provider-'))
  const runtime = path.join(dir, 'runtime')
  writeFileSync(runtime, `#!/bin/sh\n${scriptBody}\n`); chmodSync(runtime, 0o755)
  const input = path.join(dir, 'input.wav'); writeFileSync(input, 'audio')
  const model = path.join(dir, 'model.gguf'); writeFileSync(model, 'model')
  const provider = new SenseVoiceProvider({
    runtimePath: runtime,
    modelManager: { state: 'ready', ensure: async () => model } as any,
    audioPipeline: { prepare: async () => ({ wavPath: input, durationMs: 1000, cleanup: async () => {} }) } as any,
    sampleProcess: () => ({ rssBytes: 100, cpuPercent: 10 }),
  })
  return { provider, runtime }
}

function request(signal = new AbortController().signal) {
  return { inputPath: 'input', originalName: 'audio.wav', mimeType: 'audio/wav', signal }
}

describe('M2.2B SenseVoice provider', () => {
  test('returns the stable transcript contract without invented speaker or timestamps', async () => {
    const { provider } = fixture('echo 真实转写')
    const result = await provider.transcribe(request())
    expect(result).toMatchObject({ transcript: '真实转写', provider: 'sensevoice', duration_ms: 1000 })
    expect(result.chunks).toEqual([{ text: '真实转写', start_ms: null, end_ms: null, speaker: null }])
  })

  test('serializes jobs so only one SenseVoice runtime executes at once', async () => {
    const { provider } = fixture('sleep 0.08; echo ok')
    const started = Date.now()
    await Promise.all([provider.transcribe(request()), provider.transcribe(request())])
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })

  test('runtime failure does not poison the queue and a later job recovers', async () => {
    const { provider, runtime } = fixture('exit 3')
    await expect(provider.transcribe(request())).rejects.toMatchObject({ code: 'SPEECH_RUNTIME_FAILED' })
    writeFileSync(runtime, '#!/bin/sh\necho recovered\n'); chmodSync(runtime, 0o755)
    expect((await provider.transcribe(request())).transcript).toBe('recovered')
  })

  test('cancel terminates only the active runtime', async () => {
    const { provider } = fixture('sleep 5; echo late')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    await expect(provider.transcribe(request(controller.signal))).rejects.toMatchObject({ code: 'SPEECH_CANCELLED' })
  })
})
