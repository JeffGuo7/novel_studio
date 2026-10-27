/**
 * 对话压缩（/compact）：把较早的对话轮次压成结构化摘要，后续请求用摘要替代旧消息。
 *
 * 这是 pi 官方扩展点 `transformContext` 的典型用法（README 里明确写了 pruning/compaction）：
 * - 原始消息仍然保留在会话文件里（UI 可回看、可审计）；
 * - 只影响「发给模型的上下文」：system 之后插入一条摘要消息，再接最近若干轮；
 * - 多次压缩时把旧摘要与新消息一起合并，避免摘要套娃。
 */

export const COMPACTION_MARKER = '[早期对话摘要]'
export const DEFAULT_KEEP_TOKENS = 8_000

export interface CompactionState {
  /** 结构化摘要正文 */
  summary: string
  /** 已被摘要覆盖的消息条数（含 system 前缀；从 messages[0] 开始计数） */
  coveredMessages: number
  createdAt: string
}

interface MessageLike {
  role?: string
  content?: unknown
  timestamp?: number
}

/** 把压缩状态变成一条模型可见的 user 消息 */
export function buildSummaryMessage(summary: string): MessageLike {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `${COMPACTION_MARKER}\n以下是我们此前对话的压缩摘要，请在后续写作中把它当作已确认的背景（原始对话仍保留在本地，可按需让作者展开）：\n\n${summary}`,
      },
    ],
    timestamp: Date.now(),
  }
}

/**
 * 应用压缩：保留 system 前缀 + 摘要消息 + 最近未覆盖的消息。
 * 没有压缩状态时原样返回。
 */
export function applyCompaction(messages: unknown[], compaction: CompactionState | null): unknown[] {
  if (!compaction || compaction.coveredMessages <= 0) return messages
  const list = messages as MessageLike[]
  let systemCount = 0
  while (systemCount < list.length && list[systemCount]?.role === 'system') systemCount += 1
  const covered = Math.max(systemCount, Math.min(compaction.coveredMessages, list.length))
  const systems = list.slice(0, systemCount)
  const tail = list.slice(covered)
  return [...systems, buildSummaryMessage(compaction.summary), ...tail]
}

function estimateMessageText(message: MessageLike): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const item = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }
      if (item.type === 'text') return item.text ?? ''
      if (item.type === 'thinking') return item.thinking ?? ''
      if (item.type === 'toolCall') return `${item.name ?? 'tool'} ${JSON.stringify(item.arguments ?? {})}`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 选择压缩切分点：从末尾向前保留 keepBudgetTokens，切分点对齐到 user 消息。
 * 返回「被摘要覆盖的消息条数」；没有可压缩内容时返回 -1。
 */
export function selectCompactionSplit(
  messages: unknown[],
  keepBudgetTokens: number,
  estimateTokens: (text: string) => number,
): number {
  const list = messages as MessageLike[]
  let systemCount = 0
  while (systemCount < list.length && list[systemCount]?.role === 'system') systemCount += 1

  let used = 0
  let boundary = -1
  for (let index = list.length - 1; index >= systemCount; index -= 1) {
    const message = list[index]
    const cost = estimateTokens(estimateMessageText(message)) + 4
    if (used + cost > keepBudgetTokens && boundary !== -1) break
    used += cost
    if (message?.role === 'user') boundary = index
  }

  // 至少要切在一条 user 上，且前面要有内容可摘要
  if (boundary > systemCount) return boundary

  // 预算很宽（对话不算长）时的兜底：手动压缩仍然保留最近几轮，其余压掉
  const minKeep = 6
  if (list.length <= systemCount + minKeep + 1) return -1
  for (let index = Math.max(systemCount + 1, list.length - minKeep); index > systemCount; index -= 1) {
    if (list[index]?.role === 'user') return index
  }
  return -1
}

/** 把消息序列渲染成给摘要模型看的纯文本 */
export function formatMessagesForSummary(messages: unknown[], maxCharsPerMessage = 1_500): string {
  const lines: string[] = []
  for (const raw of messages) {
    const message = raw as MessageLike
    if (!message || message.role === 'system') continue
    const text = estimateMessageText(message).trim()
    if (!text) continue
    const role =
      message.role === 'assistant' ? '助手' : message.role === 'toolResult' ? '工具结果' : '作者'
    const trimmed = text.length > maxCharsPerMessage ? `${text.slice(0, maxCharsPerMessage)}\n…（截断）` : text
    lines.push(`【${role}】\n${trimmed}`)
  }
  return lines.join('\n\n')
}

/** 构造摘要提示词；previousSummary 存在时做增量合并 */
export function buildCompactionPrompt(params: {
  bookTitle: string
  transcript: string
  previousSummary?: string
}): string {
  const { bookTitle, transcript, previousSummary } = params
  const previous = previousSummary
    ? `\n\n在此之前已经有一份摘要，请把它与新内容合并后输出完整摘要（不要丢掉仍然有效的信息）：\n\n${previousSummary}\n`
    : ''
  return `你是《${bookTitle}》的写作助理，现在需要把一段较早的对话压缩成结构化摘要，供后续继续写作时使用。

要求：
1. 只保留对后续写作有用的事实与约定，不要评价、不要寒暄；
2. 作者明确确认过的设定、大纲调整、人物状态变化必须保留；
3. 输出固定结构（Markdown 小节），总长不超过 1200 字；
4. 不确定的信息不要编造，宁可省略。

输出结构：

## 写作目标
- 作者当前的写作目标 / 正在写的章节

## 已确认设定
- 世界观、人物、关系、规则等已确认的设定（含作者否决过的方案）

## 剧情进度
- 已经发生的关键事件（按时间顺序，5-10 条）

## 未解决伏笔
- 尚未回收的线索 / 待处理事项

## 用户偏好
- 作者在协作中表现出的偏好、禁忌、口头要求

${previous}

对话原文：

${transcript}`
}
