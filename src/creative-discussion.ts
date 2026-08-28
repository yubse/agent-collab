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
  avatar: string
  color: string
  envPrefix: string
  aliases: string[]
  workingPhrases: string[]
}

export const CREATIVE_AGENTS: CreativeAgentDefinition[] = [
  {
    id: 'creative', displayName: '奇想创意家', model: 'Whimsy Injector', avatar: '✨', color: 'purple', envPrefix: 'CREATIVE',
    aliases: ['creative', 'whimsy', '奇想', '奇想创意家'],
    workingPhrases: ['制造意外感...', '寻找反常规切口...', '放大趣味体验...'],
  },
  {
    id: 'brand', displayName: 'IP/品牌创意师', model: 'Brand Guardian', avatar: '🎭', color: 'blue', envPrefix: 'BRAND',
    aliases: ['brand', 'ip', '品牌', '品牌创意师', 'ip/品牌创意师'],
    workingPhrases: ['校准 IP 调性...', '提炼视觉记忆...', '守住品牌一致性...'],
  },
  {
    id: 'product', displayName: '产品创意策划', model: 'Product Manager', avatar: '🧭', color: 'green', envPrefix: 'PRODUCT',
    aliases: ['product', '产品', '产品策划', '产品创意策划'],
    workingPhrases: ['拆解购买理由...', '验证商品形态...', '收敛落地路径...'],
  },
  {
    id: 'content', displayName: '内容传播策划', model: 'Social Media Strategist', avatar: '📣', color: 'orange', envPrefix: 'CONTENT',
    aliases: ['content', 'social', '内容', '传播', '内容传播策划'],
    workingPhrases: ['设计内容钩子...', '推演 UGC 话题...', '适配平台语境...'],
  },
  {
    id: 'market', displayName: '市场现实校准员', model: 'Trend Researcher', avatar: '🔎', color: 'neutral', envPrefix: 'MARKET',
    aliases: ['market', 'growth', '市场', '校准', '市场现实校准员'],
    workingPhrases: ['核对市场信号...', '扫描竞品风险...', '校准接受度...'],
  },
  {
    id: 'moderator', displayName: '讨论主持人', model: 'Agents Orchestrator', avatar: '🎙️', color: 'blue', envPrefix: 'MODERATOR',
    aliases: ['moderator', 'host', '主持', '主持人', '讨论主持人'],
    workingPhrases: ['标记核心争议...', '合并重复观点...', '选择下一棒...'],
  },
  {
    id: 'director', displayName: '创意总监', model: 'Studio Producer', avatar: '🎬', color: 'purple', envPrefix: 'DIRECTOR',
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
  { number: 1, title: '奇想发散', agents: ['creative'] },
  { number: 2, title: 'IP + 产品回应', agents: ['brand', 'product'] },
  { number: 3, title: '内容传播挑战', agents: ['content'] },
  { number: 4, title: '市场第一次校准', agents: ['market'] },
  { number: 5, title: '创意争论与改进', agents: ['creative', 'brand'] },
  { number: 6, title: '产品 + 传播深化', agents: ['product', 'content'] },
  { number: 7, title: '争议焦点自由讨论', agents: ['moderator'], dynamicFollowup: 'debate' },
  { number: 8, title: '市场第二次校准', agents: ['market'] },
  { number: 9, title: '主持收束与最后修正', agents: ['moderator'], dynamicFollowup: 'revision' },
  { number: 10, title: '创意总监总结', agents: ['director'] },
]

export const CREATIVE_DISCUSSION_MAX_ROUNDS = CREATIVE_DISCUSSION_ROUNDS.length

export type CreativeDiscussionMessage = {
  round: number
  agentId: CreativeAgentId
  text: string
}

const ROUND_GUIDANCE: Record<number, string> = {
  1: '从反常规、趣味、视觉或体验切口大胆发散，先制造值得继续讨论的新鲜张力。',
  2: '回应第1轮：品牌侧守住IP调性和视觉记忆，产品侧验证需求、形态与购买理由。',
  3: '挑战现有想法能否变成小红书/抖音话题、UGC参与机制和前三秒内容钩子。',
  4: '用趋势、消费者、竞品与接受度第一次校准；指出风险，同时保留可改进的创意核。',
  5: '针对市场意见明确支持或反驳，并把有潜力的创意改得更新鲜、更可信。',
  6: '把候选方向深化成商品形态、购买理由、内容钩子与可执行传播动作。',
  7: '主持人先指出最大争议、重复和跑题点，并在正文中@最相关的2至3个Agent；被点名者围绕同一争议自由支持、反驳或延伸。',
  8: '对深化方案做第二次市场校准，明确接受度、差异化、主要风险和可保留条件。',
  9: '主持人收束共识与未决点，并在正文中@最需要最后修正的2至3个Agent；被点名者只做关键修正。',
  10: '去重、组合、取舍并排序，输出TOP3；每项说明保留理由，并概括其余方向的淘汰原因。',
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
  const recentMessages = prior.filter((message) => message.round === recentRound).slice(-3)

  const keyAgents: CreativeAgentId[] = round >= 9
    ? ['market', 'moderator', 'product', 'content']
    : round >= 5
      ? ['market', 'creative', 'brand', 'product', 'content']
      : ['creative', 'brand', 'product', 'content', 'market']
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
  const lengthRule = '正文约100-180字'
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
    '[关键结论]',
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
    input.round === 10 ? '- 必须明确写出 TOP1、TOP2、TOP3，并分别给出保留原因和总体淘汰原因。' : '',
  ].filter(Boolean).join('\n')
}

export function selectModeratorFollowupAgents(text: string, mode: 'debate' | 'revision'): CreativeAgentId[] {
  const normalized = text.toLowerCase()
  const selected: CreativeAgentId[] = []
  for (const agent of CREATIVE_AGENTS) {
    if (agent.id === 'moderator' || agent.id === 'director') continue
    const mentioned = agent.aliases.some((alias) => normalized.includes(`@${alias.toLowerCase()}`))
    if (mentioned && !selected.includes(agent.id)) selected.push(agent.id)
  }
  const fallback: CreativeAgentId[] = mode === 'debate'
    ? ['creative', 'market', 'product']
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
