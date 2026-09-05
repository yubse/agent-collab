import { describe, expect, test } from 'bun:test'
import '../../web/workgroup-v2/typewriter-buffer.js'

const TypewriterBuffer = (globalThis as any).AIStudioTypewriterBuffer

describe('web typewriter buffer', () => {
  test('creates an empty pending bubble before the first delta', () => {
    const buffer = new TypewriterBuffer({ autoStart: false })
    expect(buffer.begin({ messageId: 'msg-pending', channelId: 'workgroup', senderId: 'creative' })).toBe(true)
    expect(buffer.get('msg-pending')).toMatchObject({ displayedText: '', completed: false })
  })

  test('keeps concurrent agent messages independent', () => {
    const buffer = new TypewriterBuffer({ autoStart: false })
    buffer.pushDelta({ messageId: 'msg-a', channelId: 'group', senderId: 'creative', delta: '甲乙丙' })
    buffer.pushDelta({ messageId: 'msg-b', channelId: 'group', senderId: 'brand', delta: '一二三' })

    buffer.tick('msg-a')
    expect(buffer.get('msg-a').displayedText).toBe('甲')
    expect(buffer.get('msg-b').displayedText).toBe('')

    buffer.tick('msg-b')
    expect(buffer.get('msg-a').displayedText).toBe('甲')
    expect(buffer.get('msg-b').displayedText).toBe('一')
  })

  test('creates one 20ms timer per active message', () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    const buffer = new TypewriterBuffer({
      schedule: (fn: () => void, ms: number) => {
        scheduled.push({ fn, ms })
        return scheduled.length
      },
      cancel: () => {},
    })
    buffer.pushDelta({ messageId: 'msg-a', delta: 'A' })
    buffer.pushDelta({ messageId: 'msg-b', delta: 'B' })
    expect(scheduled.map(item => item.ms)).toEqual([20, 20])
  })

  test('drains real deltas before marking a result completed', () => {
    const updates: string[] = []
    const buffer = new TypewriterBuffer({ autoStart: false, onUpdate: (_: any, reason: string) => updates.push(reason) })
    buffer.pushDelta({ messageId: 'msg-a', delta: '你好' })
    buffer.finish({ messageId: 'msg-a', status: 'success', content: '你好世界' })

    expect(buffer.get('msg-a').completed).toBe(false)
    while (!buffer.get('msg-a').completed) buffer.tick('msg-a')
    expect(buffer.get('msg-a').displayedText).toBe('你好世界')
    expect(updates.at(-1)).toBe('complete')
  })

  test('does not fake streaming from an execution result without deltas', () => {
    const buffer = new TypewriterBuffer({ autoStart: false })
    expect(buffer.finish({ messageId: 'saved-only', status: 'success', content: '完整结果' })).toBe(false)
    expect(buffer.get('saved-only')).toBeNull()
  })

  test('preserves emitted content and marks an interrupted message failed', () => {
    const buffer = new TypewriterBuffer({ autoStart: false })
    buffer.pushDelta({ messageId: 'msg-a', delta: '已经显示的内容' })
    buffer.tick('msg-a')
    const shownBeforeFailure = buffer.get('msg-a').displayedText
    buffer.fail({ messageId: 'msg-a', error: 'NETWORK_INTERRUPTED' })
    while (!buffer.get('msg-a').completed) buffer.tick('msg-a')

    expect(buffer.get('msg-a').displayedText.startsWith(shownBeforeFailure)).toBe(true)
    expect(buffer.get('msg-a').displayedText).toBe('已经显示的内容')
    expect(buffer.get('msg-a').failed).toBe(true)
  })

  test('user stop freezes displayed text and rejects buffered or late content', () => {
    const buffer = new TypewriterBuffer({ autoStart: false })
    buffer.pushDelta({ messageId: 'msg-stop', delta: '已经显示但仍有积压' })
    buffer.tick('msg-stop')
    const displayed = buffer.get('msg-stop').displayedText

    expect(buffer.stop({ messageId: 'msg-stop' })).toBe(true)
    expect(buffer.get('msg-stop')).toMatchObject({
      displayedText: displayed,
      completed: true,
      failed: true,
      error: 'CODEX_EXECUTION_CANCELLED',
    })
    expect(buffer.pushDelta({ messageId: 'msg-stop', delta: '迟到内容' })).toBe(false)
    expect(buffer.finish({ messageId: 'msg-stop', status: 'success', content: '完整迟到结果' })).toBe(false)
    expect(buffer.get('msg-stop').displayedText).toBe(displayed)
  })

  test('deduplicates replayed deltas and accelerates a large backlog', () => {
    const buffer = new TypewriterBuffer({ autoStart: false })
    expect(buffer.pushDelta({ messageId: 'msg-a', eventKey: 'evt-1', delta: '甲' })).toBe(true)
    expect(buffer.pushDelta({ messageId: 'msg-a', eventKey: 'evt-1', delta: '甲' })).toBe(false)
    expect(buffer.get('msg-a').receivedText).toBe('甲')

    buffer.pushDelta({ messageId: 'msg-b', delta: '字'.repeat(500) })
    buffer.tick('msg-b')
    expect(buffer.get('msg-b').displayedText.length).toBeGreaterThan(3)
  })

  test('a fresh page state has no animation to replay', () => {
    const oldPage = new TypewriterBuffer({ autoStart: false })
    oldPage.pushDelta({ messageId: 'msg-a', delta: '实时内容' })
    const refreshedPage = new TypewriterBuffer({ autoStart: false })
    expect(refreshedPage.list()).toEqual([])
  })

  test('completed messages reject late deltas after the transient state is removed', () => {
    const buffer = new TypewriterBuffer({ autoStart: false })
    buffer.pushDelta({ messageId: 'msg-complete', eventKey: 'evt-1', delta: '完成' })
    buffer.finish({ messageId: 'msg-complete', status: 'success', content: '完成' })
    while (!buffer.get('msg-complete')?.completed) buffer.tick('msg-complete')
    expect(buffer.get('msg-complete')?.completed).toBe(true)
    buffer.remove('msg-complete')
    expect(buffer.pushDelta({ messageId: 'msg-complete', eventKey: 'evt-late', delta: '重复' })).toBe(false)
    expect(buffer.begin({ messageId: 'msg-complete' })).toBe(false)
  })

  test('duplicate result does not restart a completed message', () => {
    const buffer = new TypewriterBuffer({ autoStart: false })
    buffer.pushDelta({ messageId: 'msg-result', eventKey: 'evt-1', delta: '一次' })
    buffer.finish({ messageId: 'msg-result', status: 'success', content: '一次' })
    while (!buffer.get('msg-result')?.completed) buffer.tick('msg-result')
    expect(buffer.finish({ messageId: 'msg-result', status: 'success', content: '一次一次' })).toBe(false)
    expect(buffer.get('msg-result')?.displayedText).toBe('一次')
  })
})
