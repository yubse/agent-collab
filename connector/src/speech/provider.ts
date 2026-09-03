export type TranscriptionChunk = {
  text: string
  start_ms: number | null
  end_ms: number | null
  speaker: null
  source_start_ms?: number
  source_end_ms?: number
  processing_ms?: number
}

export type TranscriptionResult = {
  transcript: string
  chunks: TranscriptionChunk[]
  duration_ms: number
  language: string
  provider: 'sensevoice'
  runtime_version: string
  model_version: string
  processing_ms: number
  metrics?: { peak_memory_bytes: number; average_cpu_percent: number; cold_start_ms: number; model_load_count?: number; segment_count?: number }
}

export type TranscriptionRequest = {
  inputPath: string
  originalName: string
  mimeType: string
  signal: AbortSignal
  language?: string
  hotwords?: string[]
  onStage?: (stage: 'transcoding' | 'loading_model' | 'transcribing', progress: number, details?: {
    processed_audio_ms: number
    total_audio_ms: number
    segment_index: number
    segment_count: number
  }) => Promise<void> | void
}

export interface TranscriptionProvider {
  readonly name: 'sensevoice'
  status?(): { model: string; runtime: string }
  installModel?(): Promise<{ model: string; runtime: string }>
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>
}

export const SPEECH_ERROR_CODES = [
  'SPEECH_MODEL_NOT_INSTALLED',
  'SPEECH_MODEL_DOWNLOAD_FAILED',
  'SPEECH_MODEL_CHECKSUM_FAILED',
  'SPEECH_UNSUPPORTED_FORMAT',
  'SPEECH_TRANSCODE_FAILED',
  'SPEECH_RUNTIME_FAILED',
  'SPEECH_CANCELLED',
] as const

export class SpeechProviderError extends Error {
  constructor(public readonly code: string, message = code) { super(message) }
}
