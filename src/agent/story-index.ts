/**
 * 剧情 / 知识库全文检索 v2（无 embedding、无额外模型）。
 *
 * v2 变更：
 * - 除了章节正文，还索引知识文件（世界模型/状态卡/大纲/人物卡/地点卡/势力卡/卷摘要等）；
 * - 检索结果带 kind（chapter / knowledge），Agent 能区分"章节情节"和"设定卡"；
 * - 支持按章节范围过滤（chapterFrom/chapterTo），用于"只查前 50 章"这类场景；
 * - 知识文件与章节一样做 hash 增量同步；额外监听书根目录里知识文件的变化。
 *
 * 为什么是 n-gram：
 * - 中文没有空格，MiniSearch 默认按空白/标点切分会把整句当一个 token；
 * - 1-gram + 2-gram 不依赖分词器，配合 BM25 的 IDF，人物名/地名/稀有组合能排到最前。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import MiniSearch, { type Options } from 'minisearch'
import {
  KNOWLEDGE_FILES,
  KNOWLEDGE_NAMES,
  listChapters,
  readFileOrNull,
  removeFile,
} from '../core'

export type StorySourceKind = 'chapter' | 'knowledge'

export interface StoryChunk {
  id: string
  kind: StorySourceKind
  sourceKey: string
  sourceTitle: string
  chunkIndex: number
  offset: number
  preview: string
  text: string
}

interface SourceIndexEntry {
  hash: string
  chunkCount: number
}

export interface StoryIndexMeta {
  version: 2
  updatedAt: string
  chapters: Record<string, SourceIndexEntry>
  knowledge: Record<string, SourceIndexEntry>
}

export interface StorySearchHit {
  kind: StorySourceKind
  sourceKey: string
  sourceTitle: string
  chunkIndex: number
  offset: number
  preview: string
  score: number
}

export interface StorySearchOptions {
  /** 只看章节 / 只看知识文件；默认全部 */
  kind?: 'all' | 'chapter' | 'knowledge'
  /** 章节范围（含）；给出范围时默认排除知识文件（除非 kind==='knowledge'） */
  fromChapter?: number
  toChapter?: number
}

export interface StorySearchResult {
  query: string
  totalChapters: number
  totalKnowledge: number
  indexedChunks: number
  hits: StorySearchHit[]
  rebuilt: boolean
}

const INDEX_VERSION = 2
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
    fields: ['sourceTitle', 'text'],
    storeFields: ['kind', 'sourceKey', 'sourceTitle', 'chunkIndex', 'offset', 'preview', 'text'],
    tokenize: tokenizeCjk,
    searchOptions: {
      tokenize: tokenizeCjk,
      boost: { sourceTitle: 3, text: 1 },
      prefix: false,
      fuzzy: false,
    },
  }
}

function createIndex(): MiniSearch<StoryChunk> {
  return new MiniSearch<StoryChunk>(storyIndexOptions())
}

function sourceChunks(
  kind: StorySourceKind,
  sourceKey: string,
  title: string,
  content: string,
): StoryChunk[] {
  return chunkChapterText(content).map((chunk, index) => ({
    id: `${kind}:${sourceKey}:${index}`,
    kind,
    sourceKey,
    sourceTitle: title,
    chunkIndex: index,
    offset: chunk.offset,
    preview: chunk.text.slice(0, PREVIEW_CHARS),
    text: chunk.text,
  }))
}

function hashContent(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex')
}

/** 模板里只有标题/空 bullet 的知识文件不索引，避免"世界模型"这类词命中所有书 */
function hasMeaningfulKnowledge(content: string): boolean {
  const plain = content
    .replace(/^#.*$/gm, '')
    .replace(/^\s*[-*+]\s*$/gm, '')
    .replace(/[\s\-*+>#]/g, '')
  return plain.length >= 10
}

interface KnowledgeSource {
  name: string
  title: string
  content: string
}

function loadKnowledgeSources(bookDir: string): KnowledgeSource[] {
  return KNOWLEDGE_FILES.map((file) => ({
    name: file.name,
    title: file.title,
    content: readFileOrNull(path.join(bookDir, file.name)) ?? '',
  })).filter((file) => hasMeaningfulKnowledge(file.content))
}

function readMeta(bookDir: string): StoryIndexMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath(bookDir), 'utf8')) as StoryIndexMeta
    if (raw?.version !== INDEX_VERSION || typeof raw.chapters !== 'object' || typeof raw.knowledge !== 'object') {
      return null
    }
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
  /** 章节/知识文件 watcher 报告过变化；为 true 时需要重新做 hash 对齐 */
  dirty: boolean
  watchBroken: boolean
  chaptersWatcher: fs.FSWatcher | null
  knowledgeWatcher: fs.FSWatcher | null
}

let cache: IndexCache | null = null

function attachWatchers(entry: IndexCache): void {
  if (!entry.chaptersWatcher) {
    try {
      entry.chaptersWatcher = fs.watch(path.join(entry.bookDir, 'chapters'), { persistent: false }, () => {
        entry.dirty = true
      })
      entry.chaptersWatcher.on('error', () => {
        entry.watchBroken = true
      })
    } catch {
      entry.watchBroken = true
    }
  }
  if (!entry.knowledgeWatcher) {
    try {
      // 书根目录的非递归监听：知识文件被保存时会收到事件（chapters 子目录的变更由上面的 watcher 负责）
      entry.knowledgeWatcher = fs.watch(entry.bookDir, { persistent: false }, (_event, filename) => {
        const name = filename ? String(filename) : ''
        if (!name || KNOWLEDGE_NAMES.has(name)) entry.dirty = true
      })
      entry.knowledgeWatcher.on('error', () => {
        entry.watchBroken = true
      })
    } catch {
      entry.watchBroken = true
    }
  }
}

function closeWatchers(entry: IndexCache | null): void {
  try {
    entry?.chaptersWatcher?.close()
    entry?.knowledgeWatcher?.close()
  } catch {
    // ignore
  }
  if (entry) {
    entry.chaptersWatcher = null
    entry.knowledgeWatcher = null
  }
}

function emptyMeta(): StoryIndexMeta {
  return { version: INDEX_VERSION, updatedAt: '', chapters: {}, knowledge: {} }
}

function buildFresh(bookDir: string): IndexCache {
  const index = createIndex()
  const meta = emptyMeta()
  for (const chapter of listChapters(bookDir)) {
    const content = readFileOrNull(path.join(bookDir, chapter.path)) ?? ''
    const chunks = sourceChunks('chapter', chapter.key, chapter.title, content)
    index.addAll(chunks)
    meta.chapters[chapter.key] = { hash: hashContent(content), chunkCount: chunks.length }
  }
  for (const knowledge of loadKnowledgeSources(bookDir)) {
    const chunks = sourceChunks('knowledge', knowledge.name, knowledge.title, knowledge.content)
    index.addAll(chunks)
    meta.knowledge[knowledge.name] = { hash: hashContent(knowledge.content), chunkCount: chunks.length }
  }
  return {
    bookDir,
    index,
    meta,
    dirty: false,
    watchBroken: false,
    chaptersWatcher: null,
    knowledgeWatcher: null,
  }
}

function discardChunks(index: MiniSearch<StoryChunk>, kind: StorySourceKind, key: string, count: number): void {
  for (let chunkIndex = 0; chunkIndex < count; chunkIndex += 1) {
    const id = `${kind}:${key}:${chunkIndex}`
    if (index.has(id)) index.discard(id)
  }
}

/**
 * 惰性对齐索引：
 * - 首次构建后启动章节 + 知识文件 watcher，后续检索直接复用内存索引（毫秒级）；
 * - watcher 报告变化时，下一次检索重新读文件、按 hash 只重建变化部分；
 * - watcher 不可用时退化为每次全量校验（正确性优先）。
 */
export function ensureStoryIndex(bookDir: string, force = false): { cache: IndexCache; rebuilt: boolean } {
  const chapters = listChapters(bookDir)
  const knowledge = loadKnowledgeSources(bookDir)
  if (chapters.length === 0 && knowledge.length === 0) {
    return {
      cache: {
        bookDir,
        index: createIndex(),
        meta: emptyMeta(),
        dirty: false,
        watchBroken: false,
        chaptersWatcher: null,
        knowledgeWatcher: null,
      },
      rebuilt: false,
    }
  }

  const existingMeta = !force ? readMeta(bookDir) : null
  let current = cache && cache.bookDir === bookDir && existingMeta ? cache : null

  if (!current && existingMeta) {
    const loaded = loadIndex(bookDir)
    if (loaded) {
      current = {
        bookDir,
        index: loaded,
        meta: existingMeta,
        dirty: false,
        watchBroken: false,
        chaptersWatcher: null,
        knowledgeWatcher: null,
      }
    }
  }

  if (!current) {
    closeWatchers(cache)
    const fresh = buildFresh(bookDir)
    saveIndex(bookDir, fresh.index, fresh.meta)
    attachWatchers(fresh)
    cache = fresh
    return { cache: fresh, rebuilt: true }
  }

  // watcher 认为没变化：直接复用内存索引（检索不再读文件）
  if (!force && !current.dirty && !current.watchBroken) {
    return { cache: current, rebuilt: false }
  }

  let changed = force
  const meta: StoryIndexMeta = {
    ...current.meta,
    chapters: { ...current.meta.chapters },
    knowledge: { ...current.meta.knowledge },
  }
  const searchIndex = current.index

  const seenChapters = new Set<string>()
  for (const chapter of chapters) {
    seenChapters.add(chapter.key)
    const content = readFileOrNull(path.join(bookDir, chapter.path)) ?? ''
    const hash = hashContent(content)
    const previous = meta.chapters[chapter.key]
    if (previous && previous.hash === hash) continue
    if (previous) discardChunks(searchIndex, 'chapter', chapter.key, previous.chunkCount)
    const chunks = sourceChunks('chapter', chapter.key, chapter.title, content)
    searchIndex.addAll(chunks)
    meta.chapters[chapter.key] = { hash, chunkCount: chunks.length }
    changed = true
  }
  for (const [key, entry] of Object.entries(meta.chapters)) {
    if (seenChapters.has(key)) continue
    discardChunks(searchIndex, 'chapter', key, entry.chunkCount)
    delete meta.chapters[key]
    changed = true
  }

  const seenKnowledge = new Set<string>()
  for (const file of knowledge) {
    seenKnowledge.add(file.name)
    const hash = hashContent(file.content)
    const previous = meta.knowledge[file.name]
    if (previous && previous.hash === hash) continue
    if (previous) discardChunks(searchIndex, 'knowledge', file.name, previous.chunkCount)
    const chunks = sourceChunks('knowledge', file.name, file.title, file.content)
    searchIndex.addAll(chunks)
    meta.knowledge[file.name] = { hash, chunkCount: chunks.length }
    changed = true
  }
  for (const [name, entry] of Object.entries(meta.knowledge)) {
    if (seenKnowledge.has(name)) continue
    discardChunks(searchIndex, 'knowledge', name, entry.chunkCount)
    delete meta.knowledge[name]
    changed = true
  }

  current.meta = meta
  current.dirty = false
  cache = current
  attachWatchers(current)
  if (changed) saveIndex(bookDir, searchIndex, meta)
  return { cache: current, rebuilt: changed }
}

/** 只取查询里的中文二元组，用于过滤 1-gram 带来的弱相关命中 */
export function queryBigrams(text: string): string[] {
  const bigrams = new Set<string>()
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) bigrams.add(run.slice(index, index + 2))
  }
  return [...bigrams]
}

function hitAllowed(hit: Record<string, unknown>, options: StorySearchOptions): boolean {
  const kind = String(hit.kind ?? 'chapter')
  const requested = options.kind ?? 'all'
  if (requested !== 'all' && kind !== requested) return false
  const hasRange = typeof options.fromChapter === 'number' || typeof options.toChapter === 'number'
  if (kind === 'knowledge') {
    // 指定章节范围时默认只看章节；显式要求 knowledge 时保留知识结果
    return !hasRange || requested === 'knowledge'
  }
  if (!hasRange) return true
  const number = Number(String(hit.sourceKey ?? ''))
  if (!Number.isFinite(number)) return false
  if (typeof options.fromChapter === 'number' && number < options.fromChapter) return false
  if (typeof options.toChapter === 'number' && number > options.toChapter) return false
  return true
}

/** 全书检索：章节 + 知识文件，可按来源/章节范围过滤，返回相关片段（按相关度） */
export function searchStory(
  bookDir: string,
  query: string,
  limit = 5,
  options: StorySearchOptions = {},
): StorySearchResult {
  const trimmed = query.trim()
  const { cache: current, rebuilt } = ensureStoryIndex(bookDir)
  const totalChapters = Object.keys(current.meta.chapters).length
  const totalKnowledge = Object.keys(current.meta.knowledge).length
  if (!trimmed || (totalChapters === 0 && totalKnowledge === 0)) {
    return {
      query: trimmed,
      totalChapters,
      totalKnowledge,
      indexedChunks: current.index.documentCount,
      hits: [],
      rebuilt,
    }
  }
  const max = Math.max(1, Math.min(limit, 8))
  const bigrams = queryBigrams(trimmed)
  const matched = current.index.search(trimmed)
  const filtered = matched
    .filter((result) => (bigrams.length > 0 ? bigrams.some((bigram) => String(result.text ?? '').includes(bigram)) : true))
    .filter((result) => hitAllowed(result as unknown as Record<string, unknown>, options))
  const results = filtered.slice(0, max)
  const hits: StorySearchHit[] = results.map((result) => ({
    kind: String(result.kind ?? 'chapter') as StorySourceKind,
    sourceKey: String(result.sourceKey ?? ''),
    sourceTitle: String(result.sourceTitle ?? ''),
    chunkIndex: Number(result.chunkIndex),
    offset: Number(result.offset),
    preview: String(result.preview ?? ''),
    score: Number(result.score.toFixed(2)),
  }))
  return {
    query: trimmed,
    totalChapters,
    totalKnowledge,
    indexedChunks: current.index.documentCount,
    hits,
    rebuilt,
  }
}

/** 强制重建（维护入口 / 测试用） */
export function rebuildStoryIndex(bookDir: string): StoryIndexMeta {
  closeWatchers(cache)
  cache = null
  try {
    removeFile(metaPath(bookDir))
    removeFile(indexPath(bookDir))
  } catch {
    // ignore
  }
  return ensureStoryIndex(bookDir, true).cache.meta
}
