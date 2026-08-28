export const CREATIVE_AGENT_IDS = [
  'creative',
  'brand',
  'product',
  'content',
  'market',
  'moderator',
  'director',
] as const

export type CreativeAgentId = typeof CREATIVE_AGENT_IDS[number]

export type CreativeAgentDefinition = {
  id: CreativeAgentId
  displayName: string
  model: string
  reasoningEffort: 'low' | 'medium'
  pureChat: boolean
  freshThread: boolean
  avatar: string
  color: string
  envPrefix: string
  aliases: string[]
  workingPhrases: string[]
}

export const CREATIVE_AGENTS: CreativeAgentDefinition[] = [
  {
    id: 'creative', displayName: '创想家A', model: 'gpt-5.6-luna', reasoningEffort: 'low', pureChat: true, freshThread: true, avatar: '✨', color: 'purple', envPrefix: 'CREATIVE',
    aliases: ['creative', 'creator-a', '创想家a', '创想家A'],
    workingPhrases: ['制造视觉意外...', '寻找反常规切口...', '放大IP记忆点...'],
  },
  {
    id: 'brand', displayName: '创想家B', model: 'gpt-5.6-luna', reasoningEffort: 'low', pureChat: true, freshThread: true, avatar: '🎲', color: 'blue', envPrefix: 'BRAND',
    aliases: ['brand', 'creator-b', '创想家b', '创想家B'],
    workingPhrases: ['设计商品玩法...', '强化购买理由...', '组合产品形态...'],
  },
  {
    id: 'product', displayName: '创想家C', model: 'gpt-5.6-luna', reasoningEffort: 'low', pureChat: true, freshThread: true, avatar: '📣', color: 'green', envPrefix: 'PRODUCT',
    aliases: ['product', 'creator-c', '创想家c', '创想家C'],
    workingPhrases: ['制造传播钩子...', '设计UGC入口...', '适配社媒语境...'],
  },
  {
    id: 'content', displayName: '创想家D', model: 'gpt-5.6-luna', reasoningEffort: 'low', pureChat: true, freshThread: true, avatar: '🤝', color: 'orange', envPrefix: 'CONTENT',
    aliases: ['content', 'creator-d', '创想家d', '创想家D'],
    workingPhrases: ['寻找跨界对象...', '设计联名关系...', '构造体验事件...'],
  },
  {
    id: 'market', displayName: '市场现实校准员', model: 'gpt-5.6-terra', reasoningEffort: 'low', pureChat: true, freshThread: true, avatar: '🔎', color: 'neutral', envPrefix: 'MARKET',
    aliases: ['market', 'growth', '市场', '校准', '市场现实校准员'],
    workingPhrases: ['核对市场信号...', '扫描竞品风险...', '校准接受度...'],
  },
  {
    id: 'moderator', displayName: '讨论主持人', model: 'gpt-5.6-luna', reasoningEffort: 'low', pureChat: true, freshThread: true, avatar: '🎙️', color: 'blue', envPrefix: 'MODERATOR',
    aliases: ['moderator', 'host', '主持', '主持人', '讨论主持人'],
    workingPhrases: ['标记核心争议...', '合并重复观点...', '选择下一棒...'],
  },
  {
    id: 'director', displayName: '创意总监', model: 'gpt-5.6-terra', reasoningEffort: 'medium', pureChat: true, freshThread: true, avatar: '🎬', color: 'purple', envPrefix: 'DIRECTOR',
    aliases: ['director', '总监', '创意总监'],
    workingPhrases: ['组合最终方案...', '排序创意优先级...', '做最终取舍...'],
  },
]

export const CREATIVE_AGENT_BY_ID = new Map(CREATIVE_AGENTS.map((agent) => [agent.id, agent]))

export type CreativeRoundPlan = {
  number: number
  title: string
  agents: CreativeAgentId[]
  dynamicFollowup?: 'debate' | 'revision'
}

export const CREATIVE_DISCUSSION_ROUNDS: CreativeRoundPlan[] = [
  { number: 1, title: '四路并行发散', agents: ['creative', 'brand', 'product', 'content'] },
  { number: 2, title: '交叉回应与组合', agents: ['creative', 'brand', 'product', 'content'] },
  { number: 3, title: '主持挑选争议并自由讨论', agents: ['moderator'], dynamicFollowup: 'debate' },
  { number: 4, title: '市场第一次校准', agents: ['market'] },
  { number: 5, title: '四路快速修正', agents: ['creative', 'brand', 'product', 'content'] },
  { number: 6, title: '市场第二次筛选', agents: ['market'] },
  { number: 7, title: '创意总监最终筛选', agents: ['director'] },
]

export const CREATIVE_DISCUSSION_MAX_ROUNDS = CREATIVE_DISCUSSION_ROUNDS.length

export type CreativeDiscussionMessage = {
  round: number
  agentId: CreativeAgentId
  text: string
}

const ROUND_GUIDANCE: Record<number, string> = {
  1: 'A/B/C/D从各自专长独立提出明显不同的创意，不重复其他赛道，不求深度论证。',
  2: '阅读其他三位创想家的观点，明确@支持、@反驳、@组合或@延伸，形成新的候选方向。',
  3: '主持人指出偏题、重复和最大争议，并@最相关的2至3位创想家继续；被点名者只围绕该争议自由讨论。',
  4: '从市场、消费者、成本、趋势和落地性第一次校准，指出不现实、同质化或偏题之处，并给出保留条件。',
  5: '根据市场校准快速修改候选方案，保留创意核，同时降低理解、成本和执行风险。',
  6: '第二次筛选修正后的方向，明确通过、待验证和淘汰项，不再开启新方向。',
  7: '综合去重、组合、取舍并排序，最终输出TOP3至TOP5及保留、淘汰原因。',
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}

/** Select only the immediately useful context; a discussion prompt never receives full history. */
export function contextForCreativeRound(history: CreativeDiscussionMessage[], round: number): {
  keyConclusions: string[]
  recentMessages: CreativeDiscussionMessage[]
} {
  const prior = history.filter((message) => message.round < round && !isSkipCreativeResponse(message.text))
  const recentRound = Math.max(0, ...prior.map((message) => message.round))
  const recentMessages = prior.filter((message) => message.round === recentRound).slice(-4)

  const keyAgents: CreativeAgentId[] = round >= 6
    ? ['market', 'moderator', 'creative', 'brand', 'product', 'content']
    : ['creative', 'brand', 'product', 'content', 'market', 'moderator']
  const keyConclusions: string[] = []
  for (const agentId of keyAgents) {
    const message = [...prior].reverse().find((item) => item.agentId === agentId)
    if (!message) continue
    const name = CREATIVE_AGENT_BY_ID.get(agentId)?.displayName || agentId
    keyConclusions.push(`${name}：${compact(message.text, 120)}`)
    if (keyConclusions.length === 3) break
  }
  return { keyConclusions, recentMessages }
}

export function buildCreativeDiscussionPrompt(input: {
  agentId: CreativeAgentId
  topic: string
  round: number
  history: CreativeDiscussionMessage[]
  persona: string
  knowledgeContext?: string
}): string {
  const plan = CREATIVE_DISCUSSION_ROUNDS[input.round - 1]
  if (!plan) throw new Error(`creative discussion round must be 1-${CREATIVE_DISCUSSION_MAX_ROUNDS}`)
  const agent = CREATIVE_AGENT_BY_ID.get(input.agentId)
  if (!agent) throw new Error(`unknown creative agent: ${input.agentId}`)
  const context = contextForCreativeRound(input.history, input.round)
  const conclusions = context.keyConclusions.length
    ? context.keyConclusions.map((line) => `- ${line}`).join('\n')
    : '- 暂无，直接围绕原始主题建立第一批新观点。'
  const recent = context.recentMessages.length
    ? context.recentMessages.map((message) => {
      const name = CREATIVE_AGENT_BY_ID.get(message.agentId)?.displayName || message.agentId
      return `- @${name}：${compact(message.text, 280)}`
    }).join('\n')
    : '- 无。'
  const lengthRule = '正文约80-150个中文字'
  return [
    '[Agent 人设]',
    input.persona.trim(),
    '',
    `[创意讨论 · 第${input.round}/${CREATIVE_DISCUSSION_MAX_ROUNDS}轮 · ${plan.title}]`,
    `你的身份：${agent.displayName}`,
    `原始主题：${compact(input.topic, 1200)}`,
    `当前任务：${ROUND_GUIDANCE[input.round]}`,
    '',
    '[公司角色知识 · 必须遵守]',
    input.knowledgeContext?.trim()
      ? compact(input.knowledgeContext, 4000)
      : '所有方向必须以白熊百货既有角色为主角，并遵守公司知识库中的角色优先级与设定。',
    '',
    '[讨论摘要]',
    conclusions,
    '',
    '[最近必要消息]',
    recent,
    '',
    '[发言规则]',
    `- ${lengthRule}，短句、具体、只讲本轮新增价值。`,
    '- 必须针对已有观点做@支持、@反驳、@补充或@延伸；不要写成独立汇报。',
    '- 发现跑题就回到原始主题；不要复述完整历史。',
    '- 确实没有新观点时只回复 SKIP。',
    input.round === 7 ? '- 必须明确写出 TOP1 至 TOP3；若确有价值可扩展到 TOP5，并说明保留与总体淘汰原因。' : '',
  ].filter(Boolean).join('\n')
}

export function selectModeratorFollowupAgents(text: string, mode: 'debate' | 'revision'): CreativeAgentId[] {
  const normalized = text.toLowerCase()
  const selected: CreativeAgentId[] = []
  for (const agent of CREATIVE_AGENTS) {
    if (!['creative', 'brand', 'product', 'content'].includes(agent.id)) continue
    const mentioned = agent.aliases.some((alias) => normalized.includes(`@${alias.toLowerCase()}`))
    if (mentioned && !selected.includes(agent.id)) selected.push(agent.id)
  }
  const fallback: CreativeAgentId[] = mode === 'debate'
    ? ['creative', 'brand', 'product']
    : ['creative', 'product', 'content']
  for (const agentId of fallback) {
    if (selected.length >= 2) break
    if (!selected.includes(agentId)) selected.push(agentId)
  }
  return selected.slice(0, 3)
}

export function isSkipCreativeResponse(text: string): boolean {
  return /^\s*(?:SKIP|跳过|无新观点)[。.!！]?\s*$/i.test(text)
}

/** Deterministic fallback when a provider does not report input token usage. */
export function estimatePromptTokens(prompt: string): number {
  let cjk = 0
  let other = 0
  for (const char of prompt) {
    if (/\p{Script=Han}|[，。！？；：“”‘’、]/u.test(char)) cjk += 1
    else other += 1
  }
  return Math.max(1, cjk + Math.ceil(other / 4))
}
