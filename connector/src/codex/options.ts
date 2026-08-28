import type { AgentSendOpts } from '../../../src/providers/provider.ts'

const CREATIVE_AGENT_IDS = new Set([
  'creative',
  'brand',
  'product',
  'content',
  'market',
  'moderator',
  'director',
])

const MEDIUM_REASONING_AGENT_IDS = new Set(['market', 'director'])

export const PURE_CHAT_APP_SERVER_ARGS = [
  '--disable', 'shell_tool',
  '--disable', 'unified_exec',
  '--disable', 'browser_use',
  '--disable', 'computer_use',
  '--disable', 'view_image',
  '--disable', 'image_generation',
  '--disable', 'apps',
  '--disable', 'skill_search',
  '--disable', 'workspace_dependencies',
  '-c', 'web_search="disabled"',
  '-c', 'model_reasoning_summary="none"',
  '-c', 'model_verbosity="low"',
] as const

export function creativeAgentSendOptions(agentId: string): AgentSendOpts {
  const pureChat = CREATIVE_AGENT_IDS.has(agentId)
  if (!pureChat) return {}
  return {
    reasoningEffort: MEDIUM_REASONING_AGENT_IDS.has(agentId) ? 'medium' : 'low',
    pureChat,
    freshThread: pureChat,
  }
}

export function isCreativeAgent(agentId: string): boolean {
  return CREATIVE_AGENT_IDS.has(agentId)
}
