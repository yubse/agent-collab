import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'

const source = readFileSync(new URL('../../web/workgroup-v2/index.html', import.meta.url), 'utf8')

describe('D5.2 Event Timeline UI', () => {
  test('provides panel entry, safe display mapping and filters', () => {
    expect(source).toContain('channelTimelineToggle')
    expect(source).toContain('TIMELINE_FILTERS')
    expect(source).toContain('timelineDescription')
    expect(source).toContain('产生了一项活动')
  })
  test('uses bounded pagination and thread scope', () => {
    expect(source).toContain("limit: '30'")
    expect(source).toContain("params.set('thread_id', activeThread.id)")
    expect(source).toContain("data-timeline-more")
  })
  test('refreshes timeline independently from the execution stream', () => {
    expect(source).toContain('setInterval(() => loadTimelineEvents({ reset: true }), 15000)')
    expect(source).toContain('membersPanelMode')
  })
})
