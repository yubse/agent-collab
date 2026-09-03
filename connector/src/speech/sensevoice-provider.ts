import { existsSync } from 'fs'
import { unlink } from 'fs/promises'
import path from 'path'
import { AudioPipeline } from './audio-pipeline.ts'
import { ModelManager } from './model-manager.ts'
import { SENSEVOICE_MODEL, SENSEVOICE_RUNTIME, SENSEVOICE_VAD_MODEL } from './runtime-manifest.ts'
import { SpeechProviderError, type TranscriptionProvider, type TranscriptionRequest, type TranscriptionResult } from './provider.ts'

export type SenseVoiceProviderOptions = {
  runtimePath: string
  modelManager: ModelManager
  audioPipeline: AudioPipeline
  sampleProcess?: (pid: number) => { rssBytes: number; cpuPercent: number }
  segmentTimeoutMs?: number
  diagnostic?: (stage: string, fields: Record<string, unknown>) => void
}

const DEFAULT_SEGMENT_TIMEOUT_MS = 90_000

export class SenseVoiceProvider implements TranscriptionProvider {
  readonly name = 'sensevoice' as const
  private queue = Promise.resolve()
  constructor(private readonly options: SenseVoiceProviderOptions) {}

  status() {
    return { model: this.options.modelManager.state, runtime: existsSync(this.options.runtimePath) ? 'ready' : 'not_installed' }
  }

  async installModel() {
    await this.options.modelManager.ensure(SENSEVOICE_MODEL)
    await this.options.modelManager.ensure(SENSEVOICE_VAD_MODEL)
    return this.status()
  }

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const run = this.queue.then(() => this.run(request))
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async run(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const started = Date.now()
    if (request.signal.aborted) throw new SpeechProviderError('SPEECH_CANCELLED')
    await request.onStage?.('transcoding', 0.05)
    const prepared = await this.options.audioPipeline.prepare(request.inputPath, request.originalName, request.signal)
    try {
      await request.onStage?.('loading_model', 0.15)
      const modelPath = await this.options.modelManager.ensure(SENSEVOICE_MODEL, request.signal)
      const vadPath = await this.options.modelManager.ensure(SENSEVOICE_VAD_MODEL, request.signal)
      if (!existsSync(this.options.runtimePath)) throw new SpeechProviderError('SPEECH_RUNTIME_FAILED', 'SenseVoice runtime missing')
      const segments = prepared.segments || [{ wavPath: prepared.wavPath, sourceStartMs: 0, sourceEndMs: prepared.durationMs, durationMs: prepared.durationMs }]
      const chunks: TranscriptionResult['chunks'] = []
      let peakMemoryBytes = 0, cpuTotal = 0, cpuSamples = 0, firstSegmentMs = 0
      for (let index = 0; index < segments.length; index++) {
        if (request.signal.aborted) throw new SpeechProviderError('SPEECH_CANCELLED')
        const segment = segments[index]
        const processedBefore = index === 0 ? 0 : segments[index - 1].sourceEndMs
        await request.onStage?.('transcribing', 0.25 + 0.7 * (processedBefore / prepared.durationMs), {
          processed_audio_ms: processedBefore, total_audio_ms: prepared.durationMs,
          segment_index: index + 1, segment_count: segments.length,
        })
        const segmentStarted = Date.now()
        const output = await this.runSegment(segment.wavPath, modelPath, vadPath, request.signal, (sample) => {
          peakMemoryBytes = Math.max(peakMemoryBytes, sample.rssBytes); cpuTotal += sample.cpuPercent; cpuSamples++
        })
        if (index === 0) firstSegmentMs = Date.now() - segmentStarted
        chunks.push({
          text: output, start_ms: null, end_ms: null, speaker: null,
          source_start_ms: segment.sourceStartMs, source_end_ms: segment.sourceEndMs,
          processing_ms: Date.now() - segmentStarted,
        })
        await request.onStage?.('transcribing', 0.25 + 0.7 * (segment.sourceEndMs / prepared.durationMs), {
          processed_audio_ms: segment.sourceEndMs, total_audio_ms: prepared.durationMs,
          segment_index: index + 1, segment_count: segments.length,
        })
      }
      const transcript = mergeSegmentText(chunks.map((chunk) => chunk.text))
      if (!transcript) throw new SpeechProviderError('SPEECH_RUNTIME_FAILED', 'SenseVoice returned empty transcript')
      const processingMs = Date.now() - started
      return {
        transcript, chunks,
        duration_ms: prepared.durationMs,
        language: request.language || 'auto', provider: 'sensevoice',
        runtime_version: SENSEVOICE_RUNTIME.version, model_version: SENSEVOICE_MODEL.version,
        processing_ms: processingMs,
        metrics: { peak_memory_bytes: peakMemoryBytes, average_cpu_percent: cpuSamples ? cpuTotal / cpuSamples : 0, cold_start_ms: firstSegmentMs, model_load_count: segments.length, segment_count: segments.length },
      }
    } finally { await prepared.cleanup() }
  }

  private async runSegment(wavPath: string, modelPath: string, vadPath: string, signal: AbortSignal, onSample: (sample: { rssBytes: number; cpuPercent: number }) => void) {
      const startedAt = Date.now()
      const child = Bun.spawn([this.options.runtimePath, '-m', modelPath, '-a', wavPath, '--vad', vadPath, '--vad-maxseg', '25000'], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env }, detached: true,
      })
      const abort = () => {
        try { process.kill(-child.pid, 'SIGTERM') }
        catch { try { child.kill('SIGTERM') } catch {} }
      }
      signal.addEventListener('abort', abort, { once: true })
      const sampler = setInterval(() => {
        const sample = (this.options.sampleProcess || sampleProcess)(child.pid)
        onSample(sample)
      }, 100)
      const stdoutPromise = new Response(child.stdout).text()
      const stderrPromise = new Response(child.stderr).text()
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const watchdogPromise = new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => { abort(); reject(new SpeechProviderError('SPEECH_RUNTIME_FAILED', 'SenseVoice segment watchdog timeout')) }, this.options.segmentTimeoutMs ?? DEFAULT_SEGMENT_TIMEOUT_MS)
      })
      try {
        const exitCode = await Promise.race([child.exited, watchdogPromise])
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
        this.options.diagnostic?.('sensevoice_process', { exit_code: exitCode, duration_ms: Date.now() - startedAt, segment_basename: path.basename(wavPath), stderr: sanitizeRuntimeError(stderr) })
        if (signal.aborted) throw new SpeechProviderError('SPEECH_CANCELLED')
        if (exitCode !== 0) throw new SpeechProviderError('SPEECH_RUNTIME_FAILED', sanitizeRuntimeError(stderr))
        const transcript = stdout.trim()
        if (!transcript) throw new SpeechProviderError('SPEECH_RUNTIME_FAILED', 'SenseVoice returned empty transcript')
        return transcript
      } catch (error) {
        abort()
        await child.exited.catch(() => {})
        if (signal.aborted) throw new SpeechProviderError('SPEECH_CANCELLED')
        throw error
      } finally {
        if (watchdog) clearTimeout(watchdog)
        clearInterval(sampler)
        signal.removeEventListener('abort', abort)
      }
  }
}

export function mergeSegmentText(parts: string[]) {
  const clean = parts.map((part) => part.trim()).filter(Boolean)
  if (!clean.length) return ''
  let merged = clean[0]
  for (const next of clean.slice(1)) {
    let overlap = 0
    const limit = Math.min(80, merged.length, Math.max(0, next.length - 2))
    for (let length = limit; length >= 2; length--) {
      if (merged.slice(-length) === next.slice(0, length)) { overlap = length; break }
    }
    merged += `\n${next.slice(overlap)}`
  }
  return merged
}

function sampleProcess(pid: number) {
  const result = Bun.spawnSync(['/bin/ps', '-o', 'rss=,%cpu=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
  const [rss, cpu] = new TextDecoder().decode(result.stdout).trim().split(/\s+/).map(Number)
  return { rssBytes: Number.isFinite(rss) ? rss * 1024 : 0, cpuPercent: Number.isFinite(cpu) ? cpu : 0 }
}

function sanitizeRuntimeError(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/\/Users\/[^/\s]+/g, '/Users/<user>').slice(-500)
}

export function defaultSenseVoiceRuntime(appSupportDir: string) {
  return process.env.AI_STUDIO_SENSEVOICE_RUNTIME || path.join('/Library/Application Support/AIStudio/speech/runtime', SENSEVOICE_RUNTIME.binaryName)
}
