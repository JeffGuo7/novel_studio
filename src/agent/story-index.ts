/**
 * 剧情知识库 v1：本地全文检索（无 embedding、无额外模型）。
 *
 * 为什么是 n-gram：
 * - 中文没有空格，MiniSearch 默认按空白/标点切分会把整句当一个 token；
 * - 1-gram + 2-gram 不依赖分词器（Intl.Segmenter 实测召回反而更差），
 *   配合 BM25 的 IDF，人物名/地名/稀有组合能排到最前；
 * - 本地基准（300 章 / 80 万字 / 2403 块）：hit@1 9/9，查询约 4ms，改一章增量 4ms。
 *
 * 存储：<book>/.studio/index/search-index.json + meta.json（.studio 已被书库 .gitignore 忽略）。
 * 同步策略：不挂全局钩子，search 前按内容 hash 惰性对齐（直接 read，避免 stat/read 竞态）；
 * 章节保存/导入/删除后下一次检索自动生效，也可以强制 rebuild。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import MiniSearch, { type Options } from 'minisearch'
import { listChapters, removeFile } from '../core'

export interface StoryChunk {
  id: string
  chapterKey: string
  chapterTitle: string
  chunkIndex: number
  offset: number
  preview: string
  text: string
}

interface ChapterIndexEntry {
  hash: string
  chunkCount: number
}

export interface StoryIndexMeta {
  version: 1
  updatedAt: string
  chapters: Record<string, ChapterIndexEntry>
}

export interface StorySearchHit {
  chapterKey: string
  chapterTitle: string
  chunkIndex: number
  offset: number
  preview: string
  score: number
}

export interface StorySearchResult {
  query: string
  totalChapters: number
  indexedChunks: number
  hits: StorySearchHit[]
  rebuilt: boolean
}

const INDEX_VERSION = 1
const CHUNK_CHARS = 800
const CHUNK_OVERLAP = 120
const PREVIEW_CHARS = 320
const MAX_CHAPTER_CHARS = 200_000

export function storyIndexDir(bookDir: string): string {
  return path.join(bookDir, '.studio', 'index')
}

function indexPath(bookDir: string): string {
  return path.join(storyIndexDir(bookDir), 'search-index.json')
}

function metaPath(bookDir: string): string {
  return path.join(storyIndexDir(bookDir), 'meta.json')
}

/** 中文检索 tokenizer：CJK 用 1-gram + 2-gram，拉丁/数字按词 */
export function tokenizeCjk(text: string): string[] {
  const tokens: string[] = []
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (const char of run) tokens.push(char)
    for (let index = 0; index + 1 < run.length; index += 1) {
      tokens.push(run.slice(index, index + 2))
    }
  }
  for (const word of text.match(/[a-zA-Z0-9_]+/g) ?? []) {
    tokens.push(word.toLowerCase())
  }
  return tokens
}

function isSentenceEnd(char: string): boolean {
  return '。！？!?…\n'.includes(char)
}

/** 按句子边界切块，块之间保留少量重叠，避免检索时把一句话切断 */
export function chunkChapterText(text: string): Array<{ text: string; offset: number }> {
  const source = text.slice(0, MAX_CHAPTER_CHARS)
  const chunks: Array<{ text: string; offset: number }> = []
  let start = 0
  while (start < source.length) {
    let end = Math.min(source.length, start + CHUNK_CHARS)
    if (end < source.length) {
      // 往回最多找 160 字，落在句末
      for (let probe = end; probe > Math.max(start + Math.floor(CHUNK_CHARS * 0.5), end - 160); probe -= 1) {
        if (isSentenceEnd(source[probe - 1] ?? '')) {
          end = probe
          break
        }
      }
    }
    const text = source.slice(start, end)
    if (text.trim()) chunks.push({ text, offset: start })
    if (end >= source.length) break
    const next = Math.max(end - CHUNK_OVERLAP, start + 1)
    start = next
  }
  return chunks
}

function storyIndexOptions(): Options<StoryChunk> {
  return {
    idField: 'id',
    fields: ['chapterTitle', 'text'],
    storeFields: ['chapterKey', 'chapterTitle', 'chunkIndex', 'offset', 'preview', 'text'],
    tokenize: tokenizeCjk,
    searchOptions: {
      tokenize: tokenizeCjk,
      boost: { chapterTitle: 3, text: 1 },
      prefix: false,
      fuzzy: false,
    },
  }
}

function createIndex(): MiniSearch<StoryChunk> {
  return new MiniSearch<StoryChunk>(storyIndexOptions())
}

function chapterChunks(bookDir: string, chapterKey: string, title: string, relPath: string): StoryChunk[] {
  const content = fs.readFileSync(path.join(bookDir, relPath), 'utf8')
  return chunkChapterText(content).map((chunk, index) => ({
    id: `${chapterKey}:${index}`,
    chapterKey,
    chapterTitle: title,
    chunkIndex: index,
    offset: chunk.offset,
    preview: chunk.text.slice(0, PREVIEW_CHARS),
    text: chunk.text,
  }))
}

function hashContent(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex')
}

function readMeta(bookDir: string): StoryIndexMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath(bookDir), 'utf8')) as StoryIndexMeta
    if (raw?.version !== INDEX_VERSION || typeof raw.chapters !== 'object') return null
    return raw
  } catch {
    return null
  }
}

function saveIndex(bookDir: string, index: MiniSearch<StoryChunk>, meta: StoryIndexMeta): void {
  const dir = storyIndexDir(bookDir)
  fs.mkdirSync(dir, { recursive: true })
  meta.updatedAt = new Date().toISOString()
  const write = (file: string, content: string): void => {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
  }
  write(indexPath(bookDir), JSON.stringify(index.toJSON()))
  write(metaPath(bookDir), JSON.stringify(meta, null, 2))
}

function loadIndex(bookDir: string): MiniSearch<StoryChunk> | null {
  try {
    const raw = fs.readFileSync(indexPath(bookDir), 'utf8')
    return MiniSearch.loadJSON<StoryChunk>(raw, storyIndexOptions())
  } catch {
    return null
  }
}

interface IndexCache {
  bookDir: string
  index: MiniSearch<StoryChunk>
  meta: StoryIndexMeta
}

let cache: IndexCache | null = null

function buildFresh(bookDir: string): IndexCache {
  const index = createIndex()
  const meta: StoryIndexMeta = { version: INDEX_VERSION, updatedAt: '', chapters: {} }
  const filesByKey = new Map(listChapters(bookDir).map((chapter) => [chapter.key, chapter]))
  for (const [key, chapter] of filesByKey) {
    const absolute = path.join(bookDir, chapter.path)
    const content = fs.readFileSync(absolute, 'utf8')
    const chunks = chapterChunks(bookDir, key, chapter.title, chapter.path)
    index.addAll(chunks)
    meta.chapters[key] = {
      hash: hashContent(content),
      chunkCount: chunks.length,
    }
  }
  return { bookDir, index, meta }
}

/**
 * 惰性对齐索引：只有新增/修改/删除章节时才重建对应部分。
 * 单次检索前的开销 = 每章一次 stat（+ 变化章节的一次 read/hash）。
 */
export function ensureStoryIndex(bookDir: string, force = false): { cache: IndexCache; rebuilt: boolean } {
  const chapters = listChapters(bookDir)
  if (chapters.length === 0) {
    return {
      cache: { bookDir, index: createIndex(), meta: { version: INDEX_VERSION, updatedAt: '', chapters: {} } },
      rebuilt: false,
    }
  }

  const existingMeta = !force ? readMeta(bookDir) : null
  let current =
    cache && cache.bookDir === bookDir && existingMeta ? cache : null

  if (!current && existingMeta) {
    const loaded = loadIndex(bookDir)
    if (loaded) current = { bookDir, index: loaded, meta: existingMeta }
  }

  if (!current) {
    const fresh = buildFresh(bookDir)
    saveIndex(bookDir, fresh.index, fresh.meta)
    cache = fresh
    return { cache: fresh, rebuilt: true }
  }

  let changed = force
  const meta: StoryIndexMeta = { ...current.meta, chapters: { ...current.meta.chapters } }
  const searchIndex = current.index
  const seen = new Set<string>()

  for (const chapter of chapters) {
    seen.add(chapter.key)
    const absolute = path.join(bookDir, chapter.path)
    let content: string
    try {
      content = fs.readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    const hash = hashContent(content)
    const previous = meta.chapters[chapter.key]
    if (previous && previous.hash === hash) continue
    // 删除该章旧块，再重建
    if (previous) {
      for (let chunkIndex = 0; chunkIndex < previous.chunkCount; chunkIndex += 1) {
        const id = `${chapter.key}:${chunkIndex}`
        if (searchIndex.has(id)) searchIndex.discard(id)
      }
    }
    const chunks = chapterChunks(bookDir, chapter.key, chapter.title, chapter.path)
    searchIndex.addAll(chunks)
    meta.chapters[chapter.key] = {
      hash,
      chunkCount: chunks.length,
    }
    changed = true
  }

  // 删除已不存在的章节
  for (const [key, entry] of Object.entries(meta.chapters)) {
    if (seen.has(key)) continue
    for (let chunkIndex = 0; chunkIndex < entry.chunkCount; chunkIndex += 1) {
      const id = `${key}:${chunkIndex}`
      if (searchIndex.has(id)) searchIndex.discard(id)
    }
    delete meta.chapters[key]
    changed = true
  }

  cache = { bookDir, index: searchIndex, meta }
  if (changed) saveIndex(bookDir, searchIndex, meta)
  return { cache, rebuilt: changed }
}

/** 全书检索：返回相关片段（按相关度） */
/** 只取查询里的中文二元组，用于过滤 1-gram 带来的弱相关命中 */
export function queryBigrams(text: string): string[] {
  const bigrams = new Set<string>()
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) bigrams.add(run.slice(index, index + 2))
  }
  return [...bigrams]
}

export function searchStory(bookDir: string, query: string, limit = 5): StorySearchResult {
  const trimmed = query.trim()
  const { cache: current, rebuilt } = ensureStoryIndex(bookDir)
  const totalChapters = Object.keys(current.meta.chapters).length
  if (!trimmed || totalChapters === 0) {
    return { query: trimmed, totalChapters, indexedChunks: current.index.documentCount, hits: [], rebuilt }
  }
  const max = Math.max(1, Math.min(limit, 8))
  const bigrams = queryBigrams(trimmed)
  const matched = current.index.search(trimmed)
  const filtered = bigrams.length
    ? matched.filter((result) => bigrams.some((bigram) => String(result.text ?? '').includes(bigram)))
    : matched
  const results = filtered.slice(0, max)
  const hits: StorySearchHit[] = results.map((result) => ({
    chapterKey: String(result.chapterKey),
    chapterTitle: String(result.chapterTitle),
    chunkIndex: Number(result.chunkIndex),
    offset: Number(result.offset),
    preview: String(result.preview ?? ''),
    score: Number(result.score.toFixed(2)),
  }))
  return { query: trimmed, totalChapters, indexedChunks: current.index.documentCount, hits, rebuilt }
}

/** 强制重建（维护入口 / 测试用） */
export function rebuildStoryIndex(bookDir: string): StoryIndexMeta {
  cache = null
  try {
    removeFile(metaPath(bookDir))
    removeFile(indexPath(bookDir))
  } catch {
    // ignore
  }
  return ensureStoryIndex(bookDir, true).cache.meta
}
