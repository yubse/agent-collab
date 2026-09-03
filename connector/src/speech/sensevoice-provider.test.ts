import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { mergeSegmentText, SenseVoiceProvider } from './sensevoice-provider.ts'

function fixture(scriptBody: string, options: { segmentCount?: number; timeoutMs?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sensevoice-provider-'))
  const runtime = path.join(dir, 'runtime')
  writeFileSync(runtime, `#!/bin/sh\n${scriptBody}\n`); chmodSync(runtime, 0o755)
  const input = path.join(dir, 'input.wav'); writeFileSync(input, 'audio')
  const model = path.join(dir, 'model.gguf'); writeFileSync(model, 'model')
  const segments = Array.from({ length: options.segmentCount || 1 }, (_, index) => ({
    wavPath: input, sourceStartMs: index * 1000, sourceEndMs: (index + 1) * 1000, durationMs: 1000,
  }))
  const provider = new SenseVoiceProvider({
    runtimePath: runtime,
    modelManager: { state: 'ready', ensure: async () => model } as any,
    audioPipeline: { prepare: async () => ({ wavPath: input, durationMs: segments.length * 1000, segments, cleanup: async () => {} }) } as any,
    sampleProcess: () => ({ rssBytes: 100, cpuPercent: 10 }),
    segmentTimeoutMs: options.timeoutMs,
  })
  return { provider, runtime, dir }
}

function request(signal = new AbortController().signal) {
  return { inputPath: 'input', originalName: 'audio.wav', mimeType: 'audio/wav', signal }
}

describe('M2.2B SenseVoice provider', () => {
  test('returns the stable transcript contract without invented speaker or timestamps', async () => {
    const { provider } = fixture('echo 真实转写')
    const result = await provider.transcribe(request())
    expect(result).toMatchObject({ transcript: '真实转写', provider: 'sensevoice', duration_ms: 1000 })
    expect(result.chunks).toEqual([expect.objectContaining({ text: '真实转写', start_ms: null, end_ms: null, speaker: null, source_start_ms: 0, source_end_ms: 1000 })])
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

  test('accepts a valid runtime segment with no speech output', async () => {
    const { provider, runtime, dir } = fixture('if [ -f "' + '${TMP_MARKER}' + '" ]; then exit 0; else touch "' + '${TMP_MARKER}' + '"; echo speech; fi', { segmentCount: 2 })
    const marker = path.join(dir, 'marker')
    const script = (await Bun.file(runtime).text()).replaceAll('${TMP_MARKER}', marker)
    writeFileSync(runtime, script); chmodSync(runtime, 0o755)
    const result = await provider.transcribe(request())
    expect(result.transcript).toBe('speech')
    expect(result.chunks).toHaveLength(2)
  })

  test('cancel terminates only the active runtime', async () => {
    const { provider } = fixture('sleep 5; echo late')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    await expect(provider.transcribe(request(controller.signal))).rejects.toMatchObject({ code: 'SPEECH_CANCELLED' })
  })

  test('runs bounded segments sequentially and reports real source progress', async () => {
    const { provider } = fixture('sleep 0.02; echo segment', { segmentCount: 3 })
    const updates: any[] = []
    const result = await provider.transcribe({ ...request(), onStage: (stage, progress, details) => { if (details) updates.push({ stage, progress, ...details }) } })
    expect(result.chunks).toHaveLength(3)
    expect(result.transcript).toBe('segment\nsegment\nsegment')
    expect(result.metrics).toMatchObject({ segment_count: 3, model_load_count: 3 })
    expect(updates.at(-1)).toMatchObject({ processed_audio_ms: 3000, total_audio_ms: 3000, segment_index: 3, segment_count: 3 })
  })

  test('deterministically removes only an exact adjacent overlap', () => {
    expect(mergeSegmentText(['前段内容共同短语', '共同短语后段内容'])).toBe('前段内容共同短语\n后段内容')
    expect(mergeSegmentText(['相似但不相同。', '相似但不相同！'])).toBe('相似但不相同。\n相似但不相同！')
  })

  test('watchdog stops an abnormal segment instead of leaving unbounded CPU work', async () => {
    const { provider } = fixture('sleep 5; echo late', { timeoutMs: 30 })
    const started = Date.now()
    await expect(provider.transcribe(request())).rejects.toMatchObject({ code: 'SPEECH_RUNTIME_FAILED' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('cancel prevents queued segments from starting', async () => {
    const { provider, runtime, dir } = fixture('sleep 5; echo late', { segmentCount: 3 })
    const runs = path.join(dir, 'runs')
    writeFileSync(runtime, `#!/bin/sh\necho run >> "${runs}"\nsleep 5\necho late\n`); chmodSync(runtime, 0o755)
    const controller = new AbortController()
    const result = provider.transcribe({
      ...request(controller.signal),
      onStage: (stage) => { if (stage === 'transcribing') setTimeout(() => controller.abort(), 1000) },
    })
    await expect(result).rejects.toMatchObject({ code: 'SPEECH_CANCELLED' })
    expect(readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(runtime).toBeTruthy()
  })
})
