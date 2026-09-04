export const MEETING_MINUTES_AGENT_ID = 'meeting_minutes'
export const MEETING_MINUTES_AGENT = {
  id: MEETING_MINUTES_AGENT_ID,
  displayName: '会议纪要员',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low' as const,
  prompt: `你是会议纪要员。只处理已经完成的会议转写文本，不读取或猜测原始录音。\n严格输出以下 Markdown 结构：\n# 会议纪要\n## 会议信息\n- 主题\n- 时间\n- 参会人\n- 录音时长\n## 会议摘要\n## 重要讨论\n## 已确认决策\n## Action Items\n| 事项 | 负责人 | 截止时间 | 状态 |\n## 待确认事项\n## 风险 / 分歧\n## 后续跟进\n没有明确证据的负责人、时间、决策或参会人统一写“待确认”，不得编造。`}

export function splitTranscript(text: string, maxChars = 12000) {
  const clean = text.trim()
  if (!clean) return []
  const chunks: string[] = []
  for (let i = 0; i < clean.length; i += maxChars) chunks.push(clean.slice(i, i + maxChars))
  return chunks
}

export function buildMeetingMinutesPrompt(input: { title?: string | null; originalName: string; durationMs?: number | null; transcript: string; chunkIndex?: number; chunkCount?: number }) {
  const duration = input.durationMs == null ? '待确认' : `${Math.round(input.durationMs / 1000)}秒`
  return `${MEETING_MINUTES_AGENT.prompt}\n\n会议标题：${input.title || '待确认'}\n原文件：${input.originalName}\n录音时长：${duration}\n${input.chunkCount && input.chunkCount > 1 ? `这是第 ${input.chunkIndex} / ${input.chunkCount} 个转写片段。提取可核验的讨论、决策、行动项和证据，不要重复泛化内容。` : ''}\n\n[已完成 Transcript]\n${input.transcript}`
}
