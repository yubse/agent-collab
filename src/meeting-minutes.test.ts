import { describe, expect, test } from 'bun:test'
import {
  MEETING_MINUTES_AGENT,
  MEETING_MINUTES_AGENT_ID,
  buildMeetingMinutesPrompt,
  splitTranscript,
} from './meeting-minutes.ts'

describe('meeting minutes agent', () => {
  test('is an independent business agent with a constrained output contract', () => {
    expect(MEETING_MINUTES_AGENT_ID).toBe('meeting_minutes')
    expect(MEETING_MINUTES_AGENT.displayName).toBe('会议纪要员')
    expect(MEETING_MINUTES_AGENT.prompt).toContain('不得编造')
    for (const heading of ['会议摘要', '重要讨论', '已确认决策', 'Action Items', '待确认事项', '风险 / 分歧', '后续跟进']) {
      expect(MEETING_MINUTES_AGENT.prompt).toContain(heading)
    }
  })

  test('splits long transcript deterministically without dropping text', () => {
    const source = '甲'.repeat(25_001)
    const chunks = splitTranscript(source, 12_000)
    expect(chunks).toHaveLength(3)
    expect(chunks.join('')).toBe(source)
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(12_000)
  })

  test('prompt contains transcript evidence and never instructs the agent to read audio', () => {
    const prompt = buildMeetingMinutesPrompt({
      title: '产品周会',
      originalName: 'weekly.m4a',
      durationMs: 125_000,
      transcript: '确认下周发布，负责人和截止时间待确认。',
    })
    expect(prompt).toContain('产品周会')
    expect(prompt).toContain('125秒')
    expect(prompt).toContain('确认下周发布')
    expect(prompt).toContain('待确认')
    expect(prompt).not.toContain('/Users/')
  })
})
