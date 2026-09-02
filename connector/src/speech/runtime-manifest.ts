export const SENSEVOICE_RUNTIME = {
  version: 'runtime-llamacpp-v0.2.1',
  revision: '6991744856587fa44379e8b5dcc432debffeb1be',
  archiveUrl: 'https://github.com/QwenAudio/SenseVoice/releases/download/runtime-llamacpp-v0.2.1/funasr-llamacpp-macos-arm64.tar.gz',
  archiveSha256: 'bc63c4d4b96f2465f1d258600668a971f4f600d661f1859b03797cefaa417167',
  binaryName: 'llama-funasr-sensevoice',
} as const

export const SENSEVOICE_MODEL = {
  version: 'FunAudioLLM/SenseVoiceSmall-GGUF@90c1c61912018b70ada0fcc024ea24aca62f2e63:q8',
  revision: '90c1c61912018b70ada0fcc024ea24aca62f2e63',
  filename: 'sensevoice-small-q8.gguf',
  url: 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/90c1c61912018b70ada0fcc024ea24aca62f2e63/sensevoice-small-q8.gguf',
  sha256: '4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5',
} as const

export const SENSEVOICE_VAD_MODEL = {
  version: 'FunAudioLLM/fsmn-vad-GGUF@6840bae4c5c92ee8c04faaf4db23dd0105098d7f',
  filename: 'fsmn-vad.gguf',
  url: 'https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/resolve/6840bae4c5c92ee8c04faaf4db23dd0105098d7f/fsmn-vad.gguf',
  sha256: '1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479',
} as const
