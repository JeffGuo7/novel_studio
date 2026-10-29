/**
 * 写作模式：在助手输入框选择「续写 / 润色 / 审稿 / 扩写」，
 * 发送时给模型附加一段模式指令；审稿模式在 host 侧硬性禁止写草稿/提知识建议。
 */
export type AgentMode = 'free' | 'continue' | 'polish' | 'review' | 'expand'

export interface AgentModeDef {
  id: AgentMode
  label: string
  description: string
  /** 附加给模型的单行指令（free 为空） */
  instruction: string
  /** 审稿等只读模式不允许写文件 */
  readOnly?: boolean
}

export const AGENT_MODES: AgentModeDef[] = [
  {
    id: 'free',
    label: '自由',
    description: '按你的原话执行，不附加任何模式指令',
    instruction: '',
  },
  {
    id: 'continue',
    label: '续写',
    description: '接着当前章节往下写，保持文风、视角与节奏',
    instruction:
      '续写模式：接着当前章节往下写，保持既有文风、视角、人称与节奏；直接产出正文，不要解释、不要总结。',
  },
  {
    id: 'polish',
    label: '润色',
    description: '只改语言表达，不改情节与设定',
    instruction:
      '润色模式：保持原意、情节与设定不变，只优化语言表达（节奏、画面、对话、用词）；直接输出润色后的正文，不要解释改动。',
  },
  {
    id: 'review',
    label: '审稿',
    description: '只指出问题，不改写正文（只读）',
    instruction:
      '审稿模式（只读）：只指出具体问题（设定矛盾、逻辑漏洞、人物动机、节奏问题），按条目列出依据；不要重写正文，不要调用 write_draft 或 propose_knowledge。',
    readOnly: true,
  },
  {
    id: 'expand',
    label: '扩写',
    description: '把现有段落扩成更完整的正文',
    instruction:
      '扩写模式：把给定内容扩写成更完整的正文（约 2–3 倍），保留原情节与设定，补充画面、动作与细节；不要新增重大设定或人物。',
  },
]

const MODE_BY_ID = new Map(AGENT_MODES.map((mode) => [mode.id, mode]))
const MODE_PREFIX_RE = /^\[写作模式：[^\]]+\]\n[^\n]*\n\n/

export function normalizeAgentMode(value: unknown): AgentMode {
  return typeof value === 'string' && MODE_BY_ID.has(value as AgentMode)
    ? (value as AgentMode)
    : 'free'
}

export function getAgentMode(mode: AgentMode): AgentModeDef {
  return MODE_BY_ID.get(mode) ?? AGENT_MODES[0]
}

/** 把用户输入包装成带模式指令的 prompt；free 模式原样返回 */
export function buildModePrompt(text: string, mode: AgentMode): string {
  const def = getAgentMode(mode)
  if (!def.instruction) return text
  return `[写作模式：${def.label}]\n${def.instruction}\n\n${text}`
}

/** 从持久化的用户消息里去掉模式前缀，供聊天历史显示 */
export function stripModePrefix(text: string): string {
  return text.replace(MODE_PREFIX_RE, '')
}
