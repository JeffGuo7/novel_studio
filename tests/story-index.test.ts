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
  saveBookFile,
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

/** watcher 事件是异步的，测试里给目录变化一点时间 */
const settleWatcher = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

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
      expect(byPlace.hits[0].sourceKey).toBe('0001')
      expect(byPlace.hits[0].preview).toContain('雾海渡口')

      const byItem = searchStory(book.dir, '封条')
      expect(byItem.hits[0].sourceKey).toBe('0002')

      const byPerson = searchStory(book.dir, '阿九 听潮阁')
      expect(byPerson.hits[0].sourceKey).toBe('0003')

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
      await settleWatcher()

      const hits = searchStory(book.dir, '烧焦的密信')
      expect(hits.hits[0].sourceKey).toBe('0002')
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
      await settleWatcher()
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
        details: { hits: Array<{ kind: string; sourceKey: string }> }
      }
      expect(result.content[0].text).toContain('[章节 0003]')
      expect(result.content[0].text).toContain('read_chapter')
      expect(result.details.hits[0].sourceKey).toBe('0003')
    } finally {
      removeDirRecursive(root)
    }
  })
})

describe('知识文件 / 范围过滤检索', () => {
  async function setupWithKnowledge() {
    const { root, book } = await setup()
    await saveBookFile(
      book.dir,
      'characters.md',
      '# 人物卡\n\n## 林牧\n\n- 雾海渡口最后一代渡人，随身带铜哨。\n',
      'init',
      { git },
    )
    await saveBookFile(
      book.dir,
      'world_model.md',
      '# 世界模型\n\n雾海里会走出不属于这个世界的东西，渡人不能应。\n',
      'init',
      { git },
    )
    return { root, book }
  }

  it('知识文件进索引，命中带 kind/sourceTitle', async () => {
    const { root, book } = await setupWithKnowledge()
    try {
      const result = searchStory(book.dir, '渡人')
      expect(result.totalKnowledge).toBeGreaterThanOrEqual(2)
      expect(result.hits[0].kind).toBe('knowledge')
      expect(result.hits[0].sourceKey).toBe('characters.md')
      expect(result.hits[0].sourceTitle).toBe('人物卡')
      expect(result.hits[0].preview).toContain('渡人')
    } finally {
      removeDirRecursive(root)
    }
  })

  it('scope=chapter 排除知识文件；scope=knowledge 只看设定卡', async () => {
    const { root, book } = await setupWithKnowledge()
    try {
      const chapters = searchStory(book.dir, '渡人', 8, { kind: 'chapter' })
      expect(chapters.hits.every((hit) => hit.kind === 'chapter')).toBe(true)
      const knowledge = searchStory(book.dir, '渡人', 8, { kind: 'knowledge' })
      expect(knowledge.hits.length).toBeGreaterThan(0)
      expect(knowledge.hits.every((hit) => hit.kind === 'knowledge')).toBe(true)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('章节范围过滤：只查第 2 章之后', async () => {
    const { root, book } = await setupWithKnowledge()
    try {
      const inRange = searchStory(book.dir, '封条', 5, { fromChapter: 2, toChapter: 3 })
      expect(inRange.hits[0].kind).toBe('chapter')
      expect(inRange.hits[0].sourceKey).toBe('0002')

      const outOfRange = searchStory(book.dir, '封条', 5, { toChapter: 1 })
      expect(outOfRange.hits).toHaveLength(0)

      // 给范围时默认排除知识文件
      const withRange = searchStory(book.dir, '渡人', 8, { fromChapter: 1 })
      expect(withRange.hits.every((hit) => hit.kind === 'chapter')).toBe(true)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('知识文件被修改后下一次检索自动增量更新', async () => {
    const { root, book } = await setupWithKnowledge()
    try {
      searchStory(book.dir, '渡人')
      fs.writeFileSync(
        path.join(book.dir, 'characters.md'),
        '# 人物卡\n\n## 阿九\n\n- 听潮阁的旧人，手里有一枚刻着归字的铜哨。\n',
        'utf8',
      )
      await settleWatcher()
      const result = searchStory(book.dir, '铜哨')
      expect(result.hits.some((hit) => hit.kind === 'knowledge' && hit.sourceKey === 'characters.md')).toBe(true)
    } finally {
      removeDirRecursive(root)
    }
  })

  it('重建索引后 meta 里同时包含章节与知识文件', async () => {
    const { root, book } = await setupWithKnowledge()
    try {
      const meta = rebuildStoryIndex(book.dir)
      expect(Object.keys(meta.chapters).sort()).toEqual(['0001', '0002', '0003'])
      expect(meta.knowledge['characters.md']).toBeTruthy()
      expect(meta.knowledge['world_model.md']).toBeTruthy()
    } finally {
      removeDirRecursive(root)
    }
  })
})
