import { describe, expect, test } from 'bun:test'
import { creativeAgentSendOptions, PURE_CHAT_APP_SERVER_ARGS } from './options.ts'

describe('creative Codex policy', () => {
  test('uses low reasoning for ideation roles and medium for calibration/final summary', () => {
    for (const agent of ['creative', 'brand', 'product', 'content', 'moderator']) {
      expect(creativeAgentSendOptions(agent)).toMatchObject({ reasoningEffort: 'low', pureChat: true, freshThread: true })
    }
    for (const agent of ['market', 'director']) {
      expect(creativeAgentSendOptions(agent)).toMatchObject({ reasoningEffort: 'medium', pureChat: true, freshThread: true })
    }
  })

  test('disables non-chat app-server capabilities', () => {
    const args = PURE_CHAT_APP_SERVER_ARGS.join(' ')
    for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'view_image', 'image_generation', 'apps', 'skill_search', 'workspace_dependencies']) {
      expect(args).toContain(feature)
    }
    expect(args).toContain('web_search="disabled"')
  })
})
