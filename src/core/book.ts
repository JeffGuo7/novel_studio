import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { BookMeta, BookSnapshot, ChapterInfo, KnowledgeFileInfo } from '../shared/types'
import { CoreError } from './errors'
import { countWords, ensureDir, readFileOrNull, removeFile, writeFileAtomic } from './fsutil'
import { createGitPort, type GitPort } from './git'
import { listDraftChapterKeys, listDrafts } from './drafts'
import {
  chapterWordsWithCache,
  readChapterWordCache,
  writeChapterWordCache,
  type ChapterWordEntry,
} from './chapter-cache'

export interface KnowledgeFileDef {
  name: string
  title: string
  template: string
}

/** 一书一库：这些文件是长期维护的创作知识，随正史一起进 Git */
export const KNOWLEDGE_FILES: KnowledgeFileDef[] = [
  {
    name: 'world_model.md',
    title: '世界模型',
    template: '# 世界模型\n\n## 读者承诺与主轴\n\n- \n\n## 力量 / 规则体系\n\n- \n\n## 势力与地理\n\n- \n\n## 硬约束\n\n- \n',
  },
  {
    name: 'status_card.md',
    title: '状态卡',
    template: '# 状态卡\n\n## 当前时间与地点\n\n- \n\n## 人物状态\n\n- \n\n## 最近事件\n\n- \n',
  },
  {
    name: 'summary.md',
    title: '剧情总纲',
    template: '# 剧情总纲\n\n## 已发生\n\n- \n\n## 待推进\n\n- \n',
  },
  {
    name: 'characters.md',
    title: '人物卡',
    template: '# 人物卡\n\n> 每个主要人物：身份 / 目标 / 关系 / 当前状态 / 最近变化\n\n- \n',
  },
  {
    name: 'locations.md',
    title: '地点卡',
    template: '# 地点卡\n\n> 每个关键地点：位置 / 规则 / 氛围 / 与谁相关\n\n- \n',
  },
  {
    name: 'factions.md',
    title: '势力卡',
    template: '# 势力卡\n\n> 每个势力：目标 / 资源 / 与主角关系 / 当前动向\n\n- \n',
  },  {
    name: 'brainstorm.md',
    title: '灵感池',
    template: '# 灵感池\n\n- \n',
  },
  {
    name: 'master_outline.md',
    title: '主线大纲',
    template: '# 主线大纲\n\n## 读者承诺\n\n- \n\n## 长线冲突\n\n- \n',
  },
  {
    name: 'arc_outline.md',
    title: '篇章大纲',
    template: '# 篇章大纲\n\n## 第一卷\n\n- \n',
  },
  {
    name: 'chapter_outline.md',
    title: '逐章大纲',
    template: '# 逐章大纲\n\n## 第 1 章\n\n- 场景：\n- 冲突：\n- 转折：\n',
  },
  {
    name: 'volume_summary.md',
    title: '卷摘要',
    template: '# 卷摘要\n\n> 每卷 3-5 条：本卷目标 / 关键事件 / 结尾状态 / 遗留钩子\n\n## 第一卷\n\n- \n',
  },  {
    name: 'style_guide.md',
    title: '文风指南',
    template: '# 文风指南\n\n## 句式与节奏\n\n- \n\n## 禁忌写法\n\n- \n',
  },
  {
    name: 'style_fingerprint.md',
    title: '文风指纹',
    template: '# 文风指纹\n\n- 平均句长：\n- 常用意象：\n- 人称与视角：\n',
  },
  {
    name: 'error_archive.md',
    title: '错误档案',
    template: '# 错误档案\n\n> 每条：现象 / 原因 / 规避规则\n\n- \n',
  },
]

/** 当前 book.json schema 版本；升级逻辑见 normalizeBookMeta */
export const CURRENT_BOOK_SCHEMA = 1

export const KNOWLEDGE_NAMES = new Set(KNOWLEDGE_FILES.map((item) => item.name))

const CHAPTER_FILE_RE = /^(\d{4})_(.+)\.md$/
// oxlint-disable-next-line no-control-regex -- 文件名必须过滤控制字符
const ILLEGAL_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]/g

export interface CreateBookInput {
  title: string
  author?: string
}

export interface BookServiceOptions {
  git?: GitPort
  now?: () => Date
}

function gitOf(options: BookServiceOptions): GitPort {
  return options.git ?? createGitPort()
}

function nowIso(options: BookServiceOptions): string {
  return (options.now?.() ?? new Date()).toISOString()
}

export function sanitizeTitle(title: string): string {
  return title
    .replace(ILLEGAL_NAME_RE, '')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
}

export function bookDirName(title: string): string {
  const slug = sanitizeTitle(title) || 'book'
  const hash = crypto.createHash('sha1').update(title.trim()).digest('hex').slice(0, 8)
  return `${slug}_${hash}`
}

export function chapterKeyOf(index: number): string {
  return String(index).padStart(4, '0')
}

/** 章节标题用于文件名：允许空格（比连字符更接近原标题），只去掉非法字符 */
export function sanitizeChapterTitle(title: string): string {
  return title
    .replace(ILLEGAL_NAME_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 40)
}

export function chapterFileName(key: string, title: string): string {
  const safe = sanitizeChapterTitle(title) || '未命名'
  return `${key}_${safe}.md`
}

export function parseChapterFileName(fileName: string): { key: string; number: number; title: string } | null {
  const match = fileName.match(CHAPTER_FILE_RE)
  if (!match) return null
  return { key: match[1], number: Number(match[1]), title: match[2] }
}

/** 只允许写章节 markdown 和白名单知识文件 */
export function assertWritablePath(bookDir: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').trim()
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new CoreError('PATH_REJECTED', `illegal path: ${relPath}`)
  }
  const isChapter = /^chapters\/[^/]+\.md$/.test(normalized)
  const isKnowledge = KNOWLEDGE_NAMES.has(normalized)
  if (!isChapter && !isKnowledge) {
    throw new CoreError('PATH_REJECTED', `path not allowed: ${relPath}`)
  }
  const absolute = path.resolve(bookDir, normalized)
  const bookRoot = path.resolve(bookDir)
  if (absolute !== bookRoot && !absolute.startsWith(bookRoot + path.sep)) {
    throw new CoreError('PATH_REJECTED', `path escapes book dir: ${relPath}`)
  }
  return absolute
}

function normalizeBookMeta(parsed: Partial<BookMeta>, fallbackId: string): { meta: BookMeta; migrated: boolean } {
  const schemaVersion = Number(parsed.schemaVersion ?? 0)
  if (schemaVersion > CURRENT_BOOK_SCHEMA) {
    throw new CoreError(
      'BROKEN_BOOK_JSON',
      `这本书由更新版本的 Novel Studio 创建（book.json schemaVersion=${schemaVersion}），请升级应用后再打开`,
    )
  }
  const now = new Date().toISOString()
  const meta: BookMeta = {
    schemaVersion: CURRENT_BOOK_SCHEMA,
    id: String(parsed.id ?? fallbackId),
    title: String(parsed.title ?? '').trim(),
    author: String(parsed.author ?? '佚名'),
    createdAt: String(parsed.createdAt ?? now),
    updatedAt: String(parsed.updatedAt ?? now),
    ...(typeof parsed.description === 'string' && parsed.description.trim()
      ? { description: parsed.description.trim().slice(0, 2_000) }
      : {}),
    ...(typeof parsed.cover === 'string' && /^cover\.(png|jpe?g|webp)$/i.test(parsed.cover)
      ? { cover: parsed.cover }
      : {}),
  }
  if (!meta.title) throw new CoreError('BROKEN_BOOK_JSON', 'book.json 缺少书名（title）')
  const migrated =
    schemaVersion !== CURRENT_BOOK_SCHEMA ||
    !parsed.schemaVersion ||
    !parsed.author ||
    !parsed.createdAt ||
    !parsed.updatedAt ||
    !parsed.id
  return { meta, migrated }
}

/** 读取并规范化 book.json；旧 schema 返回 migrated=true，由调用方决定是否写回 */
function readMetaForSnapshot(bookDir: string): { meta: BookMeta; migrated: boolean } {
  const raw = readFileOrNull(path.join(bookDir, 'book.json'))
  if (!raw) throw new CoreError('NOT_A_BOOK', `${bookDir} is not a book directory`)
  let parsed: Partial<BookMeta>
  try {
    parsed = JSON.parse(raw) as Partial<BookMeta>
  } catch (err) {
    throw new CoreError('BROKEN_BOOK_JSON', `book.json is invalid: ${(err as Error).message}`)
  }
  const fallbackId = path.basename(bookDir)
  return normalizeBookMeta(parsed, fallbackId)
}

function writeMeta(bookDir: string, meta: BookMeta): void {
  writeFileAtomic(path.join(bookDir, 'book.json'), JSON.stringify(meta, null, 2) + '\n')
}

export function listChapters(bookDir: string): ChapterInfo[] {
  const chaptersDir = path.join(bookDir, 'chapters')
  if (!fs.existsSync(chaptersDir)) return []
  const draftKeys = new Set(listDraftChapterKeys(bookDir))
  const cache = readChapterWordCache(bookDir)
  const nextEntries: Record<string, ChapterWordEntry> = {}
  let cacheChanged = false

  const chapters = fs
    .readdirSync(chaptersDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .flatMap((entry) => {
      const parsed = parseChapterFileName(entry.name)
      if (!parsed) return []
      const relPath = `chapters/${entry.name}`
      const cached = chapterWordsWithCache(
        bookDir,
        relPath,
        path.join(chaptersDir, entry.name),
        cache,
      )
      nextEntries[relPath] = cached.entry
      if (cached.changed) cacheChanged = true
      const hasDraft = draftKeys.has(parsed.key)
      return [
        {
          key: parsed.key,
          number: parsed.number,
          title: parsed.title,
          path: relPath,
          words: cached.words,
          hasDraft,
          draftVersions: hasDraft ? listDrafts(bookDir, parsed.key).length : 0,
        } satisfies ChapterInfo,
      ]
    })
    .sort((a, b) => a.number - b.number)

  // 删除的章节/失效条目需要从缓存里清掉
  if (!cacheChanged && Object.keys(cache).length !== Object.keys(nextEntries).length) {
    cacheChanged = true
  }
  if (cacheChanged) writeChapterWordCache(bookDir, nextEntries)
  return chapters
}

export function nextChapterKey(bookDir: string): string {
  const chapters = listChapters(bookDir)
  const chapterMax = chapters.reduce((max, item) => Math.max(max, item.number), 0)
  const draftMax = listDraftChapterKeys(bookDir).reduce((max, key) => Math.max(max, Number(key)), 0)
  return chapterKeyOf(Math.max(chapterMax, draftMax) + 1)
}

function knowledgeInfos(bookDir: string): KnowledgeFileInfo[] {
  return KNOWLEDGE_FILES.map((file) => {
    const content = readFileOrNull(path.join(bookDir, file.name)) ?? ''
    return { name: file.name, title: file.title, words: countWords(content) }
  })
}

const STUDIO_STATE_FILE = path.join('.studio', 'state.json')
const COVER_MAX_BYTES = 2.5 * 1024 * 1024
const COVER_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

interface StudioState {
  lastOpenedAt?: string
}

function readStudioState(bookDir: string): StudioState {
  const raw = readFileOrNull(path.join(bookDir, STUDIO_STATE_FILE))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as StudioState
    return typeof parsed.lastOpenedAt === 'string' ? { lastOpenedAt: parsed.lastOpenedAt } : {}
  } catch {
    return {}
  }
}

/** 记录最近打开时间（.studio 内，不进 Git） */
export function touchBookOpened(bookDir: string): void {
  try {
    const state = readStudioState(bookDir)
    writeFileAtomic(
      path.join(bookDir, STUDIO_STATE_FILE),
      JSON.stringify({ ...state, lastOpenedAt: new Date().toISOString() }, null, 2),
    )
  } catch {
    // 统计信息失败不影响打开
  }
}

function readCoverDataUrl(bookDir: string, cover: string | undefined): string | undefined {
  if (!cover) return undefined
  try {
    const file = path.join(bookDir, cover)
    const stat = fs.statSync(file)
    if (stat.size <= 0 || stat.size > COVER_MAX_BYTES) return undefined
    const ext = path.extname(cover).toLowerCase()
    const mime =
      ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    return undefined
  }
}

export interface UpdateBookInfoInput {
  title?: string
  author?: string
  description?: string
}

/** 更新书名 / 作者 / 简介（目录名与内部 id 不变，避免破坏书库相对路径） */
export async function updateBookInfo(
  bookDir: string,
  input: UpdateBookInfoInput,
  options: BookServiceOptions = {},
): Promise<BookSnapshot> {
  const git = gitOf(options)
  const { meta } = readMetaForSnapshot(bookDir)
  const title = input.title !== undefined ? input.title.trim() : meta.title
  if (!title) throw new CoreError('INVALID_TITLE', '书名不能为空')
  if (title.length > 80) throw new CoreError('INVALID_TITLE', '书名过长（最多 80 字）')
  const author = input.author !== undefined ? input.author.trim() || '佚名' : meta.author
  const description =
    input.description !== undefined ? input.description.trim().slice(0, 2_000) : meta.description
  const next: BookMeta = {
    ...meta,
    title,
    author,
    updatedAt: new Date().toISOString(),
    ...(description ? { description } : {}),
  }
  if (!description) delete next.description
  writeMeta(bookDir, next)
  await git.commitPaths(bookDir, ['book.json'], `[书] 更新书籍信息：${title}`)
  return snapshotBook(bookDir, options)
}

/** 设置封面：校验格式/大小后复制进书目录，并删除旧封面 */
export async function setBookCover(
  bookDir: string,
  sourceFile: string,
  options: BookServiceOptions = {},
): Promise<BookSnapshot> {
  const git = gitOf(options)
  const ext = path.extname(sourceFile).toLowerCase()
  if (!COVER_EXTS.has(ext)) {
    throw new CoreError('INVALID_COVER', '封面只支持 PNG / JPG / WebP 图片')
  }
  const stat = fs.statSync(sourceFile)
  if (stat.size <= 0) throw new CoreError('INVALID_COVER', '封面文件为空')
  if (stat.size > COVER_MAX_BYTES) throw new CoreError('INVALID_COVER', '封面图片不能超过 2.5MB')

  const { meta } = readMetaForSnapshot(bookDir)
  const coverName = `cover${ext === '.jpeg' ? '.jpg' : ext}`
  for (const old of ['cover.png', 'cover.jpg', 'cover.jpeg', 'cover.webp']) {
    if (old !== coverName) removeFile(path.join(bookDir, old))
  }
  fs.copyFileSync(sourceFile, path.join(bookDir, coverName))
  writeMeta(bookDir, { ...meta, cover: coverName, updatedAt: new Date().toISOString() })
  await git.commitPaths(bookDir, ['book.json', coverName], '[书] 更新封面')
  return snapshotBook(bookDir, options)
}

/** 删除封面 */
export async function clearBookCover(
  bookDir: string,
  options: BookServiceOptions = {},
): Promise<BookSnapshot> {
  const git = gitOf(options)
  const { meta } = readMetaForSnapshot(bookDir)
  const changed: string[] = []
  for (const name of ['cover.png', 'cover.jpg', 'cover.jpeg', 'cover.webp']) {
    if (removeFile(path.join(bookDir, name))) changed.push(name)
  }
  const next: BookMeta = { ...meta, updatedAt: new Date().toISOString() }
  delete next.cover
  writeMeta(bookDir, next)
  await git.commitPaths(bookDir, ['book.json', ...changed], '[书] 删除封面')
  return snapshotBook(bookDir, options)
}

export async function snapshotBook(
  bookDir: string,
  options: BookServiceOptions = {},
): Promise<BookSnapshot> {
  const git = gitOf(options)
  const { meta, migrated } = readMetaForSnapshot(bookDir)
  if (migrated) {
    writeMeta(bookDir, meta)
    try {
      await git.commitPaths(bookDir, ['book.json'], '[书] 升级 book.json schema')
    } catch {
      // Git 不可用时只写文件，不阻塞打开
    }
  }
  const chapters = listChapters(bookDir)
  const studioState = readStudioState(bookDir)
  const coverDataUrl = readCoverDataUrl(bookDir, meta.cover)
  const draftKeys = new Set(listDraftChapterKeys(bookDir))
  const chapterKeys = new Set(chapters.map((item) => item.key))
  const orphanDraftKeys = [...draftKeys].filter((key) => !chapterKeys.has(key)).sort()
  let head: string | null = null
  let branch: string | null = null
  try {
    head = await git.head(bookDir)
    branch = await git.currentBranch(bookDir)
  } catch {
    head = null
  }
  return {
    dir: bookDir,
    meta,
    chapters,
    knowledge: knowledgeInfos(bookDir),
    orphanDraftKeys,
    head,
    branch,
    ...(studioState.lastOpenedAt ? { lastOpenedAt: studioState.lastOpenedAt } : {}),
    ...(coverDataUrl ? { coverDataUrl } : {}),
  }
}

export async function createBook(
  rootDir: string,
  input: CreateBookInput,
  options: BookServiceOptions = {},
): Promise<BookSnapshot> {
  const title = input.title?.trim()
  if (!title) throw new CoreError('INVALID_TITLE', '书名不能为空')
  if (title.length > 80) throw new CoreError('INVALID_TITLE', '书名过长（最多 80 字）')

  const git = gitOf(options)
  ensureDir(rootDir)
  const dirName = bookDirName(title)
  const bookDir = path.join(rootDir, dirName)
  if (fs.existsSync(bookDir)) {
    throw new CoreError('BOOK_EXISTS', `书已存在：${dirName}`)
  }
  ensureDir(bookDir)
  ensureDir(path.join(bookDir, 'chapters'))

  const meta: BookMeta = {
    schemaVersion: 1,
    id: dirName,
    title,
    author: input.author?.trim() || '佚名',
    createdAt: nowIso(options),
    updatedAt: nowIso(options),
  }
  writeMeta(bookDir, meta)
  for (const file of KNOWLEDGE_FILES) {
    writeFileAtomic(path.join(bookDir, file.name), file.template)
  }
  writeFileAtomic(path.join(bookDir, '.gitignore'), '.studio/\n.DS_Store\nThumbs.db\n')

  await git.init(bookDir)
  await git.commitPaths(
    bookDir,
    ['book.json', '.gitignore', ...KNOWLEDGE_FILES.map((file) => file.name)],
    '[初始化] 建立书库',
  )
  return snapshotBook(bookDir, options)
}

export async function listBooks(
  rootDir: string,
  options: BookServiceOptions = {},
): Promise<BookSnapshot[]> {
  if (!fs.existsSync(rootDir)) return []
  const entries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
  const books: BookSnapshot[] = []
  for (const entry of entries) {
    const bookDir = path.join(rootDir, entry.name)
    if (!fs.existsSync(path.join(bookDir, 'book.json'))) continue
    try {
      books.push(await snapshotBook(bookDir, options))
    } catch {
      // 跳过损坏的书目，不让一本书拖垮书架
    }
  }
  return books.sort((a, b) => a.meta.title.localeCompare(b.meta.title, 'zh-Hans-CN'))
}

export async function readBookFile(
  bookDir: string,
  relPath: string,
  ref?: string,
  options: BookServiceOptions = {},
): Promise<{ content: string; exists: boolean }> {
  const absolute = assertWritablePath(bookDir, relPath)
  if (ref) {
    const git = gitOf(options)
    const content = await git.readFileAt(bookDir, ref, relPath.replace(/\\/g, '/'))
    return { content: content ?? '', exists: content !== null }
  }
  const content = readFileOrNull(absolute)
  return { content: content ?? '', exists: content !== null }
}

export async function saveBookFile(
  bookDir: string,
  relPath: string,
  content: string,
  message?: string,
  options: BookServiceOptions = {},
): Promise<{ oid: string | null; snapshot: BookSnapshot }> {
  const absolute = assertWritablePath(bookDir, relPath)
  const previous = readFileOrNull(absolute)
  if (previous === content) {
    return { oid: null, snapshot: await snapshotBook(bookDir, options) }
  }
  writeFileAtomic(absolute, content)
  const git = gitOf(options)
  const defaultMessage = relPath.startsWith('chapters/')
    ? `[章节] 更新 ${relPath.replace(/^chapters\//, '').replace(/\.md$/, '')}`
    : `[知识] 更新 ${relPath.replace(/\.md$/, '')}`
  const oid = await git.commitPaths(bookDir, [relPath], message?.trim() || defaultMessage)
  return { oid, snapshot: await snapshotBook(bookDir, options) }
}
