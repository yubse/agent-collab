import { describe, expect, test } from 'bun:test'
import path from 'path'

const root = path.join(import.meta.dir, '../../web')
const html = await Bun.file(path.join(root, 'transcriptions/index.html')).text()
const page = await Bun.file(path.join(root, 'transcriptions/transcriptions.js')).text()
const upload = await Bun.file(path.join(root, 'workgroup-v2/speech-upload.js')).text()

describe('M2.3 meeting transcription UI', () => {
  test('keeps the recording local and supports the four real formats', () => {
    expect(html).toContain('原始录音仅在当前电脑本地处理，不会上传服务器')
    expect(html).toContain('.wav,.mp3,.m4a,.mp4')
    expect(upload).toContain('body: file,')
    expect(upload).not.toContain('duplex:')
    expect(upload).toContain('stage=speech_grant_ready')
    expect(upload).toContain('stage=speech_fetch_start')
    expect(upload).toContain('stage=speech_fetch_response')
    expect(upload).toContain('stage=speech_fetch_throw')
    expect(upload).not.toContain('X-AIStudio-Original-Name')
    expect(upload).toContain('original_name: file.name')
    expect(upload).not.toContain("fetch('/upload")
  })

  test('keeps SSE alive beyond Bun idle timeout without coupling upload failure to cancel', async () => {
    const server = await Bun.file(path.join(root, '../server.ts')).text()
    expect(server).toContain('server.timeout(req, 0)')
    expect(page).not.toContain('events.onerror=async()=>window.AIStudioSpeech.cancel')
  })

  test('shows first model installation and automatically resumes the pending job', () => {
    expect(html).toContain('首次使用需要安装本地语音识别模型')
    expect(page).toContain('window.AIStudioSpeech.installModel()')
    expect(page).toContain('if(action)await action()')
  })

  test('restores history and progress from NAS SSE without creating another job', () => {
    expect(page).toContain("api('/api/transcriptions')")
    expect(page).toContain("new EventSource('/api/transcriptions/stream')")
    expect(page).not.toContain('onmessage=async e=>{await start')
    expect(page).toContain('processed_audio_ms')
    expect(page).toContain('total_audio_ms')
    expect(page).toContain('Object.assign(row,u)')
    expect(page).not.toContain("t.status==='completed'?'100%':'35%'")
    expect(page).toContain("events.onerror=()=>{streamRetrying=true")
    expect(page).not.toContain('events.onerror=async()=>window.AIStudioSpeech.cancel')
  })

  test('supports copy, delete and explicit local-file retry after refresh', () => {
    expect(page).toContain('navigator.clipboard.writeText')
    expect(page).toContain("method:'DELETE'")
    expect(page).toContain("currentFileId===currentId")
    expect(page).toContain("else $('fileInput').click()")
    expect(page).toContain('重新转写需要再次选择本地录音')
  })

  test('renders stable user-facing errors instead of runtime internals', () => {
    for (const label of ['Helper未连接', 'Speech Service未运行', '模型安装失败', '音频格式错误', '音频转码失败', '语音识别失败', '已取消']) {
      expect(html + page).toContain(label)
    }
    expect(page).not.toContain('binary path')
    expect(page).not.toContain('stack trace')
  })

  test('exposes independent meeting minutes generation and version history', () => {
    expect(html).toContain('生成会议纪要')
    expect(html).toContain('会议纪要')
    expect(page).toContain('/minutes`')
    expect(page).toContain('正在整理会议纪要')
    expect(page).toContain('历史版本会保留')
    expect(page).toContain('markdown(')
  })

  test('does not render Markdown table separator as an Action Item', () => {
    expect(page).toContain('cells.every(cell=>/^:?-{3,}:?$/.test(cell))')
    expect(page).toContain("if(cells.length&&cells.every(cell=>/^:?-{3,}:?$/.test(cell)))return ''")
  })
})
