import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../web/workgroup-v2/index.html', import.meta.url), 'utf8')

describe('transport and state performance safeguards', () => {
  test('uses SSE as the primary channel transport with reconciliation fallback', () => {
    expect(source).toContain('const POLL_MS = 10000;')
    expect(source).toContain('const POLL_FALLBACK_MS = 2000;')
    expect(source).toContain('_executionStreamSource.onopen')
    expect(source).toContain('_executionStreamSource.onerror')
    expect(source).toContain('_setExecutionStreamHealth(false)')
  })

  test('task list and detail use existing long-poll waiter endpoints', () => {
    expect(source).toContain('/tasks/summary?since_cursor=')
    expect(source).toContain('/tasks/${encodeURIComponent(taskId)}/events?since_event_id=')
    expect(source).not.toContain('tasksV2PollTimer = setInterval(_fetchTasksV2Once, 5000)')
    expect(source).not.toContain('tasksV2DetailPollTimer = setInterval(() =>')
  })

  test('browser requests carry safe correlation ids for performance diagnostics', () => {
    expect(source).toContain("headers['x-request-id']")
    expect(source).toContain('web_${Date.now()}_')
  })

  test('boot loads profile, roster and channels independently with a bounded timeout', () => {
    expect(source).toContain('const BOOT_REQUEST_TIMEOUT_MS = 5000;')
    expect(source).toContain('Promise.allSettled([')
    expect(source).toContain("loadCurrentProfile(),")
    expect(source).toContain("loadRoster(),")
    expect(source).toContain("loadGroups(),")
    expect(source).toContain("controller.abort(new DOMException('boot request timeout', 'TimeoutError'))")
    expect(source).toContain("data-boot-retry=\"channels\"")
    expect(source).toContain("bootTrace('boot_start')")
    expect(source).toContain("bootTrace('poll_start')")
  })
})
