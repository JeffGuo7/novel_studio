import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { createBook, createGitPort, listDrafts, nextChapterKey, removeDirRecursive } from '../src/core'
import { createNovelAgent } from '../src/agent/create-agent'

/** 从 .env.local 读 key；没有就跳过（CI 不会跑这条） */
function resolveKey(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const file = path.join(process.cwd(), '.env.local')
  if (!fs.existsSync(file)) return ''
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+)\s*$/)
    if (match) return match[1].trim()
  }
  return ''
}

const apiKey = resolveKey()

describe.skipIf(!apiKey)('DeepSeek 真实链路', () => {
  it(
    'Agent 读取上下文并把新章节写成草稿版本',
    async () => {
      process.env.DEEPSEEK_API_KEY = apiKey
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-agent-live-'))
      const git = createGitPort()
      try {
        const book = await createBook(root, { title: '雾海纪事' }, { git })
        fs.writeFileSync(
          path.join(book.dir, 'world_model.md'),
          `# 世界模型

## 读者承诺与主轴
- 北境渡口「雾海」每七日一场大雾，雾里会走出不属于这个世界的东西。
- 主角林牧是最后一代渡人，规矩：雾里有人招手，不能应。

## 规则体系
- 渡人三条规矩：不应、不回头、不点灯。答了话会被记走「名」。

## 势力
- 镇渊司：官府机构，收三倍渡税。
`,
        )
        fs.writeFileSync(
          path.join(book.dir, 'status_card.md'),
          `# 状态卡

- 时间：雾夜，亥时
- 地点：雾海渡口，旧渡船
- 林牧：二十四岁，渡人，父亲三年前在雾中失踪
`,
        )
        fs.writeFileSync(
          path.join(book.dir, 'style_guide.md'),
          `# 文风指南

- 短句为主，画面具体，少形容词堆砌
- 对话独立成段，克制
`,
        )
        fs.writeFileSync(
          path.join(book.dir, 'chapter_outline.md'),
          '# 逐章大纲\n\n## 第 1 章 雾夜渡客\n\n- 场景：雾夜，渡船，镇渊司封条\n- 冲突：渡客身份不明，林牧不敢答话\n- 转折：船底传来第二次声音\n',
        )

        const models = createModels()
        models.setProvider(deepseekProvider())
        const available = models.getModels('deepseek')
        // 测试统一用便宜模型，避免意外烧钱
        const model = available.find((item) => item.id === 'deepseek-flash') ?? available[0]

        const chapterKey = nextChapterKey(book.dir)
        const events: string[] = []
        const agent = createNovelAgent({
          bookDir: book.dir,
          bookTitle: book.meta.title,
          model,
          streamFn: models.streamSimple.bind(models),
          nextChapterKey: chapterKey,
        })
        agent.subscribe((event: { type: string }) => {
          events.push(event.type)
        })

        await agent.prompt(
          `请写第 1 章《雾夜渡客》的正文，目标 600-900 字，写完用 write_draft 保存为 chapterKey=${chapterKey} 的草稿。`,
        )
        await agent.waitForIdle()

        const drafts = listDrafts(book.dir, chapterKey)
        if (drafts.length === 0) {
          const said = agent.state.messages
            .filter((message) => message.role === 'assistant')
            .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            .filter((block) => block.type === 'text')
            .map((block) => (block as { text: string }).text)
            .join('\n')
          console.log('[live] 没有草稿，模型回复：', said.slice(0, 600))
        }
        expect(drafts.length).toBeGreaterThan(0)
        const content = fs.readFileSync(
          path.join(book.dir, '.studio', 'drafts', chapterKey, `v${String(drafts[0].version).padStart(3, '0')}.md`),
          'utf8',
        )
        expect(content.replace(/\s+/g, '').length).toBeGreaterThan(300)
        expect(events).toContain('tool_execution_start')
        console.log('[live] model:', model.id, '| draft words:', drafts[0].words, '| events:', events.length)
      } finally {
        removeDirRecursive(root)
      }
    },
    180_000,
  )
})
