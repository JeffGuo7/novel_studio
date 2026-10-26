/**
 * 工具调用的人话摘要。
 * 不依赖 pi SDK / core，主进程、utilityProcess、会话历史共用同一份实现，
 * 保证「实时轨迹」和「刷新后的历史轨迹」文案一致。
 */
export function summarizeToolCall(name: string, args: unknown): string {
  const data = (args ?? {}) as Record<string, unknown>
  switch (name) {
    case 'read_context':
      return data.chapterKey ? `读取第 ${Number(data.chapterKey)} 章上下文` : '读取全书上下文'
    case 'list_chapters':
      return '查看章节列表'
    case 'read_chapter':
      return `读取第 ${Number(data.chapterKey)} 章正文`
    case 'read_knowledge':
      return `读取 ${String(data.name)}`
    case 'write_draft': {
      const content = typeof data.content === 'string' ? data.content : ''
      return `写入草稿（${content.replace(/\s+/g, '').length} 字）`
    }
    case 'list_drafts':
      return `查看第 ${Number(data.chapterKey)} 章草稿`
    case 'book_history':
      return '查看正史历史'
    default:
      return name
  }
}
