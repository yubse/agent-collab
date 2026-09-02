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
}

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
      const modelStarted = Date.now()
      const modelPath = await this.options.modelManager.ensure(SENSEVOICE_MODEL, request.signal)
      const vadPath = await this.options.modelManager.ensure(SENSEVOICE_VAD_MODEL, request.signal)
      if (!existsSync(this.options.runtimePath)) throw new SpeechProviderError('SPEECH_RUNTIME_FAILED', 'SenseVoice runtime missing')
      await request.onStage?.('transcribing', 0.25)
      const child = Bun.spawn([this.options.runtimePath, '-m', modelPath, '-a', prepared.wavPath, '--vad', vadPath, '--vad-maxseg', '30000'], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env }, detached: true,
      })
      const abort = () => {
        try { process.kill(-child.pid, 'SIGTERM') }
        catch { try { child.kill('SIGTERM') } catch {} }
      }
      request.signal.addEventListener('abort', abort, { once: true })
      let peakMemoryBytes = 0, cpuTotal = 0, cpuSamples = 0
      const sampler = setInterval(() => {
        const sample = (this.options.sampleProcess || sampleProcess)(child.pid)
        peakMemoryBytes = Math.max(peakMemoryBytes, sample.rssBytes)
        cpuTotal += sample.cpuPercent; cpuSamples++
      }, 100)
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      clearInterval(sampler)
      request.signal.removeEventListener('abort', abort)
      if (request.signal.aborted) throw new SpeechProviderError('SPEECH_CANCELLED')
      if (exitCode !== 0) throw new SpeechProviderError('SPEECH_RUNTIME_FAILED', sanitizeRuntimeError(stderr))
      const transcript = stdout.trim()
      if (!transcript) throw new SpeechProviderError('SPEECH_RUNTIME_FAILED', 'SenseVoice returned empty transcript')
      const processingMs = Date.now() - started
      return {
        transcript,
        chunks: [{ text: transcript, start_ms: null, end_ms: null, speaker: null }],
        duration_ms: prepared.durationMs,
        language: request.language || 'auto', provider: 'sensevoice',
        runtime_version: SENSEVOICE_RUNTIME.version, model_version: SENSEVOICE_MODEL.version,
        processing_ms: processingMs,
        metrics: { peak_memory_bytes: peakMemoryBytes, average_cpu_percent: cpuSamples ? cpuTotal / cpuSamples : 0, cold_start_ms: Date.now() - modelStarted },
      }
    } finally { await prepared.cleanup() }
  }
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
