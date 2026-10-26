import { describe, expect, it } from 'vitest'
import { summarizeToolCall } from '../src/agent/tool-summary'

describe('工具调用摘要', () => {
  it('读上下文 / 读章节 / 知识文件', () => {
    expect(summarizeToolCall('read_context', { chapterKey: '0007' })).toBe('读取第 7 章上下文')
    expect(summarizeToolCall('read_context', {})).toBe('读取全书上下文')
    expect(summarizeToolCall('read_chapter', { chapterKey: '0012' })).toBe('读取第 12 章正文')
    expect(summarizeToolCall('read_knowledge', { name: 'world_model.md' })).toBe('读取 world_model.md')
  })

  it('写草稿按字数统计', () => {
    expect(summarizeToolCall('write_draft', { content: '雾从水面长出来' })).toBe('写入草稿（7 字）')
    expect(summarizeToolCall('write_draft', { content: ' 1 2 3 ' })).toBe('写入草稿（3 字）')
  })

  it('列表 / 历史 / 未知工具', () => {
    expect(summarizeToolCall('list_chapters', {})).toBe('查看章节列表')
    expect(summarizeToolCall('list_drafts', { chapterKey: '0003' })).toBe('查看第 3 章草稿')
    expect(summarizeToolCall('book_history', {})).toBe('查看正史历史')
    expect(summarizeToolCall('some_new_tool', {})).toBe('some_new_tool')
  })
})
