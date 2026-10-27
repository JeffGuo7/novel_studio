import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBook,
  createGitPort,
  deleteChapter,
  importTextIntoBook,
  removeDirRecursive,
} from '../src/core'
import {
  chunkChapterText,
  rebuildStoryIndex,
  searchStory,
  storyIndexDir,
  tokenizeCjk,
} from '../src/agent/story-index'
import { createNovelTools } from '../src/agent/tools'

const git = createGitPort()

const SAMPLE = `第一章 雾夜渡客

雾从水面长出来。林牧在雾海渡口救下苏晚，把她拖上渡船。

第二章 七日之限

镇渊司的封条贴在船头。青袍人说七日内补交三倍渡税。

第三章 听潮阁来信

阿九在听潮阁交出渡籍，签下了自己的名字。
`

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-story-index-'))
  const book = await createBook(root, { title: '索引测试书' }, { git })
  await importTextIntoBook(book.dir, { text: SAMPLE, source: '样本.txt' }, { git })
  return { root, book }
}

describe('中文 n-gram tokenizer', () => {
  it('生成单字与二元 token，拉丁词单独处理', () => {
    const tokens = tokenizeCjk('雾海渡口 abc-42')
    expect(tokens).toContain('雾')
    expect(tokens).toContain('雾海')
    expect(tokens).toContain('海渡')
    expect(tokens).toContain('渡口')
    expect(tokens).toContain('abc')
    expect(tokens).toContain('42')
  })
})

describe('章节切块', () => {
  it('长章节切成多块，偏移递增且覆盖全文', () => {
    const text = '林牧把船撑离岸边。'.repeat(200)
    const chunks = chunkChapterText(text)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[0].offset).toBe(0)
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index].offset).toBeGreaterThan(chunks[index - 1].offset)
    }
    expect(chunks[chunks.length - 1].offset + chunks[chunks.length - 1].text.length).toBe(text.length)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(800)
  })

  it('短章节只有一块', () => {
    const chunks = chunkChapterText('雾从水面长出来。')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].offset).toBe(0)
  })
})

describe('剧情索引检索', () => {
  it('能按人物/地点/事件检索到对应章节，并持久化索引', async () => {
    const { root, book } = await setup()
    try {
      const byPlace = searchStory(book.dir, '雾海渡口')
      expect(byPlace.hits[0].chapterKey).toBe('0001')
      expect(byPlace.hits[0].preview).toContain('雾海渡口')

      const byItem = searchStory(book.dir, '封条')
      expect(byItem.hits[0].chapterKey).toBe('0002')

      const byPerson = searchStory(book.dir, '阿九 听潮阁')
      expect(byPerson.hits[0].chapterKey).toBe('0003')

      expect(fs.existsSync(path.join(storyIndexDir(book.dir), 'search-index.json'))).toBe(true)
      expect(fs.existsSync(path.join(storyIndexDir(book.dir), 'meta.json'))).toBe(true)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('章节修改后索引自动增量更新', async () => {
    const { root, book } = await setup()
    try {
      searchStory(book.dir, '封条') // 先建索引
      const chapter2 = path.join(book.dir, 'chapters', fs.readdirSync(path.join(book.dir, 'chapters')).find((name) => name.startsWith('0002_'))!)
      fs.writeFileSync(chapter2, '# 第二章 七日之限\n\n青袍人带来了一封烧焦的密信。\n', 'utf8')

      const hits = searchStory(book.dir, '烧焦的密信')
      expect(hits.hits[0].chapterKey).toBe('0002')
      // 旧内容不应再出现在首位
      expect(hits.hits[0].preview).toContain('密信')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('删除章节后检索不再命中该章内容', async () => {
    const { root, book } = await setup()
    try {
      expect(searchStory(book.dir, '交出渡籍').hits.length).toBeGreaterThan(0)
      await deleteChapter(book.dir, '0003', { git })
      const after = searchStory(book.dir, '交出渡籍')
      expect(after.hits).toHaveLength(0)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('rebuildStoryIndex 重建索引', async () => {
    const { root, book } = await setup()
    try {
      const meta = rebuildStoryIndex(book.dir)
      expect(Object.keys(meta.chapters)).toEqual(['0001', '0002', '0003'])
    } finally {
      removeDirRecursive(root)
    }
  })

  it('search_story 工具输出片段与章节定位', async () => {
    const { root, book } = await setup()
    try {
      const tool = createNovelTools(book.dir).find((item) => item.name === 'search_story')
      expect(tool).toBeTruthy()
      const result = (await tool!.execute('call-1', { query: '阿九 听潮阁', limit: 3 })) as {
        content: Array<{ type: string; text: string }>
        details: { hits: Array<{ chapterKey: string }> }
      }
      expect(result.content[0].text).toContain('[0003]')
      expect(result.content[0].text).toContain('read_chapter')
      expect(result.details.hits[0].chapterKey).toBe('0003')
    } finally {
      removeDirRecursive(root)
    }
  })
})
