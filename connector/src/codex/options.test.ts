import { describe, expect, test } from 'bun:test'
import { creativeAgentSendOptions, PURE_CHAT_APP_SERVER_ARGS } from './options.ts'

describe('creative Codex policy', () => {
  test('reads model and reasoning from each creative agent configuration', () => {
    for (const agent of ['creative', 'brand', 'product', 'content', 'moderator']) {
      expect(creativeAgentSendOptions(agent)).toMatchObject({ model: 'gpt-5.6-luna', reasoningEffort: 'low', pureChat: true, freshThread: true })
    }
    expect(creativeAgentSendOptions('market')).toMatchObject({ model: 'gpt-5.6-terra', reasoningEffort: 'low', pureChat: true, freshThread: true })
    expect(creativeAgentSendOptions('director')).toMatchObject({ model: 'gpt-5.6-terra', reasoningEffort: 'medium', pureChat: true, freshThread: true })
    expect(creativeAgentSendOptions('unconfigured-agent')).toEqual({})
  })

  test('disables non-chat app-server capabilities', () => {
    const args = PURE_CHAT_APP_SERVER_ARGS.join(' ')
    for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'view_image', 'image_generation', 'apps', 'skill_search', 'workspace_dependencies']) {
      expect(args).toContain(feature)
    }
    expect(args).toContain('web_search="disabled"')
  })
})
