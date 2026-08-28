import { describe, expect, test } from 'bun:test'
import {
  CREATIVE_AGENT_IDS,
  CREATIVE_DISCUSSION_MAX_ROUNDS,
  CREATIVE_DISCUSSION_ROUNDS,
  buildCreativeDiscussionPrompt,
  contextForCreativeRound,
  estimatePromptTokens,
  isSkipCreativeResponse,
  selectModeratorFollowupAgents,
} from './creative-discussion.ts'

describe('creative discussion plan', () => {
  test('defines seven agents and exactly ten rounds', () => {
    expect(CREATIVE_AGENT_IDS).toHaveLength(7)
    expect(CREATIVE_DISCUSSION_MAX_ROUNDS).toBe(10)
    expect(CREATIVE_DISCUSSION_ROUNDS.map((round) => round.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(CREATIVE_DISCUSSION_ROUNDS[9]?.agents).toEqual(['director'])
  })

  test('prompt contains the current round but not full history', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      round: Math.min(6, index + 1),
      agentId: (['creative', 'brand', 'product', 'content', 'market'] as const)[index % 5]!,
      text: `历史观点-${index}-${'内容'.repeat(80)}`,
    }))
    const prompt = buildCreativeDiscussionPrompt({
      agentId: 'market', topic: '设计一个能被年轻人主动分享的节日礼盒', round: 8, history, persona: '# 市场现实校准员\n- 冷静但不扫兴。',
      knowledgeContext: '1. 潘潘：鲷鱼烧店主。\n2. 潘妮：潘潘妹妹。',
    })
    expect(prompt).toContain('第8/10轮')
    expect(prompt).toContain('[关键结论]')
    expect(prompt).toContain('[最近必要消息]')
    expect(prompt).toContain('[公司角色知识 · 必须遵守]')
    expect(prompt).toContain('潘潘：鲷鱼烧店主')
    expect(prompt).toContain('100-180字')
    expect(prompt).not.toContain('历史观点-0-')
    expect(contextForCreativeRound(history, 8).recentMessages.length).toBeLessThanOrEqual(3)
  })

  test('moderator chooses two to three mentioned agents with safe fallbacks', () => {
    expect(selectModeratorFollowupAgents('请 @奇想创意家 与 @市场现实校准员 正面讨论', 'debate')).toEqual(['creative', 'market'])
    expect(selectModeratorFollowupAgents('争议仍不清楚', 'revision')).toEqual(['creative', 'product'])
    expect(selectModeratorFollowupAgents('@brand @product @content @market', 'debate')).toEqual(['brand', 'product', 'content'])
  })

  test('supports explicit skip and token estimation', () => {
    expect(isSkipCreativeResponse('SKIP')).toBe(true)
    expect(isSkipCreativeResponse('无新观点。')).toBe(true)
    expect(isSkipCreativeResponse('我补充一个观点')).toBe(false)
    expect(estimatePromptTokens('中文提示 prompt')).toBeGreaterThan(0)
  })
})
