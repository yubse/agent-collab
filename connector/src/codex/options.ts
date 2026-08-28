import type { AgentSendOpts } from '../../../src/providers/provider.ts'
import { CREATIVE_AGENT_BY_ID, type CreativeAgentId } from '../../../src/creative-discussion.ts'

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
  const config = CREATIVE_AGENT_BY_ID.get(agentId as CreativeAgentId)
  if (!config) return {}
  return {
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    pureChat: config.pureChat,
    freshThread: config.freshThread,
  }
}

export function isCreativeAgent(agentId: string): boolean {
  return CREATIVE_AGENT_BY_ID.has(agentId as CreativeAgentId)
}
