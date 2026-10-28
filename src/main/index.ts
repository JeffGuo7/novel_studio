import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  createBook,
  createChapterDraft,
  createGitPort,
  discardDrafts,
  listBooks,
  listChapters,
  listDrafts,
  promoteDraft,
  readBookFile,
  readDraft,
  saveBookFile,
  saveDraft,
  seedDraft,
  snapshotBook,
  toCoreError,
  importFileIntoBook,
  importManyFilesIntoBook,
  importTextIntoBook,
  deleteChapter,
  trashBook,
  acceptKnowledgeProposal,
  listKnowledgeProposals,
  rejectKnowledgeProposal,
  loadExportBook,
  buildMergedMarkdown,
  buildPlainText,
  updateBookInfo,
  setBookCover,
  clearBookCover,
  touchBookOpened,
  renumberChapters,
  listAutosaves,
  writeAutosave,
  discardAutosave,
  searchBook,
  replaceInBook,
  moveChapter,
  insertChapterAfter,
  mergeChapterIntoNext,
  splitChapter,
  ensureAllSchemas,
  ensureBookSchema,
  getWorkspaceSchemaVersion,
} from '../core'
import type { AutosaveEntryInfo, Result } from '../shared/types'
import type { SettingsSaveInput } from '../shared/model-config'
import { loadSession } from '../agent/session-store'
import { toChatHistory } from '../agent/session-state'
import { AgentManager } from './agent-manager'
import { PipelineManager } from './pipeline-manager'
import { OutlineManager } from './outline-manager'
import { ReviewManager } from './review-manager'
import { getLogger, initLogger } from './logger'
import { UpdateManager } from './updater'
import {
  defaultBackupName,
  exportWorkspace,
  inspectBackup,
  restoreWorkspace,
  scanWorkspaceHealth,
} from './backup-core'
import { autoBackupStatus, runAutoBackup } from './backup-scheduler'
import { buildEpub } from './export-epub'
import { planKnowledgeUpdate } from '../pipeline/knowledge'
import { getAutoBackupConfig, getProxyUrl, getSettings, saveSettings } from './settings-store'
import { testModelConnection } from './test-connection'
import { ensureTomatoAvailable, importTomatoBook, searchTomatoBooks } from './tomato-manager'
import { compareStyleMetrics, computeStyleMetrics, parseFingerprintMetrics } from '../shared/style'

const git = createGitPort()

// 测试/隔离用：允许把 userData 指到临时目录
if (process.env.NOVEL_STUDIO_USER_DATA) {
  app.setPath('userData', process.env.NOVEL_STUDIO_USER_DATA)
}

/** 读取项目根的 .env.local（本地密钥，永不提交） */
function loadLocalEnv(): void {
  // 测试/CI 可以显式跳过本地 .env.local，避免真实密钥影响首启/E2E 断言
  if (process.env.NOVEL_STUDIO_SKIP_LOCAL_ENV === '1') return
  const candidates = [path.join(app.getAppPath(), '.env.local'), path.join(process.cwd(), '.env.local')]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (key && process.env[key] === undefined) process.env[key] = value
    }
    break
  }
}

let mainWindow: BrowserWindow | null = null

/**
 * 向渲染进程发事件时的统一守卫。
 * 窗口关闭/崩溃后 webContents 会被销毁，此时 send 会抛
 * "Object has been destroyed"（主进程未捕获异常 → 系统报错弹窗）。
 * Agent / 知识管线都是异步推流，事件经常比窗口晚到，必须丢包而不是崩。
 */
function sendToWindow(channel: string, payload: unknown): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  const contents = win.webContents
  if (!contents || contents.isDestroyed()) return
  try {
    contents.send(channel, payload)
  } catch {
    // 窗口正在关闭，丢弃这条事件
  }
}

function logMainProcessError(label: string, error: unknown): void {
  getLogger().error(label, error)
}

// 主进程兜底：异步推流/退出阶段的竞态不应该弹系统错误框，写到日志里便于排查
process.on('uncaughtException', (error) => logMainProcessError('uncaughtException', error))
process.on('unhandledRejection', (reason) => logMainProcessError('unhandledRejection', reason))

const agentManager = new AgentManager((event) => {
  sendToWindow('agent:event', event)
})

const pipelineManager = new PipelineManager((event) => {
  sendToWindow('pipeline:event', event)
})

const outlineManager = new OutlineManager((event) => {
  sendToWindow('outline:event', event)
})

const reviewManager = new ReviewManager((event) => {
  sendToWindow('review:event', event)
})

const updateManager = new UpdateManager((event) => {
  sendToWindow('update:event', event)
})

let updateChecked = false

function workspaceRoot(): string {
  const override = process.env.NOVEL_STUDIO_HOME
  const root = override || path.join(app.getPath('documents'), 'NovelStudio')
  fs.mkdirSync(root, { recursive: true })
  return root
}

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

function fail(err: unknown): Result<never> {
  const e = toCoreError(err)
  return { ok: false, error: { code: e.code, message: e.message } }
}

function handle<TInput, TOutput>(
  channel: string,
  fn: (input: TInput) => Promise<TOutput> | TOutput,
): void {
  ipcMain.handle(channel, async (_event, input: TInput) => {
    try {
      return ok(await fn(input))
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err)
      return fail(err)
    }
  })
}

function applySessionProxy(): void {
  const proxy = getProxyUrl()
  const proxyRules = proxy.replace(/^https?:\/\//i, '')
  void session.defaultSession
    .setProxy(proxyRules ? { mode: 'fixed_servers', proxyRules } : { mode: 'system' })
    .catch(() => undefined)
}

function backupRoot(): string {
  return path.join(app.getPath('userData'), 'backups')
}

/** 到点就备份一次（失败只记日志，不打扰正在写作的用户） */
function maybeAutoBackup(force = false): void {
  const config = getAutoBackupConfig()
  if (!config.enabled && !force) return
  try {
    const status = autoBackupStatus(backupRoot(), config)
    if (!force && !status.due) return
    const result = runAutoBackup(workspaceRoot(), backupRoot(), config.keep)
    getLogger().info('自动备份完成', {
      file: result.file,
      books: result.report?.books ?? 0,
      bytes: result.report?.bytes ?? 0,
      pruned: result.pruned,
    })
  } catch (err) {
    getLogger().warn('自动备份失败', { error: err instanceof Error ? err.message : String(err) })
  }
}

function registerIpc(): void {
  handle('workspace:root', async () => workspaceRoot())

  handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    userData: app.getPath('userData'),
    workspace: workspaceRoot(),
    workspaceSchema: getWorkspaceSchemaVersion(workspaceRoot()),
  }))

  handle(
    'app:log',
    async (input: { level?: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown }) => {
      const level = input.level ?? 'error'
      getLogger()[level](`renderer: ${String(input.message ?? '').slice(0, 500)}`, input.data)
      return { logged: true }
    },
  )

  handle('app:openDir', async (input: { target: 'userData' | 'workspace' | 'logs' | 'backups' }) => {
    const target =
      input.target === 'userData'
        ? app.getPath('userData')
        : input.target === 'logs'
          ? path.join(app.getPath('userData'), 'logs')
          : input.target === 'backups'
            ? backupRoot()
            : workspaceRoot()
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return { opened: true }
  })

  handle('update:check', async () => updateManager.check())
  handle('update:download', async () => updateManager.download())
  handle('update:install', async () => updateManager.install())
  handle('update:openPage', async () => {
    updateManager.openPage()
    return { opened: true }
  })

  handle('backup:export', async (input: { filePath?: string }) => {
    let target = input?.filePath
    if (!target) {
      const result = await dialog.showSaveDialog({
        title: '备份书库',
        defaultPath: path.join(app.getPath('documents'), defaultBackupName()),
        filters: [{ name: 'Novel Studio 备份', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      target = result.filePath
    }
    const report = exportWorkspace(workspaceRoot(), target)
    return { canceled: false, report }
  })

  const pickBackupFile = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择备份文件',
      properties: ['openFile'],
      filters: [{ name: 'Novel Studio 备份', extensions: ['zip'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }

  handle('backup:inspect', async (input: { filePath?: string }) => {
    let source: string | undefined = input?.filePath
    if (!source) source = (await pickBackupFile()) ?? undefined
    if (!source) return { canceled: true }
    return { canceled: false, file: source, inspect: inspectBackup(source, workspaceRoot()) }
  })

  handle(
    'backup:restore',
    async (input: { filePath?: string; books?: string[] }) => {
      let source: string | undefined = input?.filePath
      if (!source) source = (await pickBackupFile()) ?? undefined
      if (!source) return { canceled: true }
      const report = restoreWorkspace(source, workspaceRoot(), { books: input?.books })
      return { canceled: false, report }
    },
  )

  handle('backup:autoStatus', async () => autoBackupStatus(backupRoot(), getAutoBackupConfig()))

  handle('backup:runAuto', async () => {
    const config = getAutoBackupConfig()
    try {
      const result = runAutoBackup(workspaceRoot(), backupRoot(), config.keep)
      return {
        ran: true,
        ...(result.file ? { file: result.file } : {}),
        message: result.report
          ? `已自动备份 ${result.report.books} 本书（${Math.round(result.report.bytes / 1024 / 1024)} MB）`
          : '已自动备份',
      }
    } catch (err) {
      return { ran: false, message: (err as Error).message }
    }
  })

  handle('backup:health', async () => scanWorkspaceHealth(workspaceRoot()))

  handle(
    'export:book',
    async (input: { dir: string; format: 'md' | 'txt' | 'epub'; filePath?: string }) => {
      const book = loadExportBook(input.dir)
      const extension = input.format === 'md' ? 'md' : input.format === 'txt' ? 'txt' : 'epub'
      const safeTitle = book.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'book'
      let target = input.filePath
      if (!target) {
        const filters =
          input.format === 'md'
            ? [{ name: 'Markdown', extensions: ['md'] }]
            : input.format === 'txt'
              ? [{ name: '纯文本', extensions: ['txt'] }]
              : [{ name: 'EPUB', extensions: ['epub'] }]
        const result = await dialog.showSaveDialog({
          title: '导出书稿',
          defaultPath: path.join(app.getPath('documents'), `${safeTitle}.${extension}`),
          filters,
        })
        if (result.canceled || !result.filePath) return { canceled: true }
        target = result.filePath
      }
      const content =
        input.format === 'md'
          ? buildMergedMarkdown(book)
          : input.format === 'txt'
            ? buildPlainText(book)
            : await buildEpub(book)
      const tmp = `${target}.tmp-${process.pid}`
      fs.writeFileSync(tmp, content)
      fs.renameSync(tmp, target)
      return {
        canceled: false,
        file: target,
        format: input.format,
        chapters: book.chapters.length,
        bytes: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength,
      }
    },
  )

  handle(
    'search:book',
    async (input: {
      dir: string
      query: string
      caseSensitive?: boolean
      includeKnowledge?: boolean
    }) =>
      searchBook(input.dir, input.query, {
        caseSensitive: input.caseSensitive,
        includeKnowledge: input.includeKnowledge,
      }),
  )

  handle(
    'search:replace',
    async (input: {
      dir: string
      query: string
      replacement: string
      caseSensitive?: boolean
      paths?: string[]
    }) => {
      stopAgentBeforeReorg()
      return replaceInBook(input.dir, input.query, input.replacement, {
        caseSensitive: input.caseSensitive,
        paths: input.paths,
        git,
      })
    },
  )

  handle('autosave:list', async (input: { dir: string }) => listAutosaves(input.dir))

  handle('autosave:write', async (input: { dir: string; entry: AutosaveEntryInfo }) =>
    writeAutosave(input.dir, input.entry),
  )

  handle('autosave:discard', async (input: { dir: string; id: string }) => ({
    discarded: discardAutosave(input.dir, input.id),
  }))

  handle('app:revealFile', async (input: { path: string }) => {
    shell.showItemInFolder(input.path)
    return { revealed: true }
  })

  handle('workspace:list', async () => listBooks(workspaceRoot(), { git }))

  handle('workspace:create', async (input: { title: string; author?: string }) =>
    createBook(workspaceRoot(), input, { git }),
  )

  handle('book:open', async (input: { dir: string }) => {
    try {
      ensureBookSchema(input.dir)
    } catch (err) {
      getLogger().warn('书 schema 检查失败', {
        dir: input.dir,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    touchBookOpened(input.dir)
    return snapshotBook(input.dir, { git })
  })

  handle(
    'book:updateInfo',
    async (input: { dir: string; title?: string; author?: string; description?: string }) =>
      updateBookInfo(input.dir, {
        title: input.title,
        author: input.author,
        description: input.description,
      }, { git }),
  )

  handle('book:setCover', async (input: { dir: string; filePath?: string }) => {
    let source = input.filePath
    if (!source) {
      const result = await dialog.showOpenDialog({
        title: '选择书籍封面',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      source = result.filePaths[0]
    }
    const snapshot = await setBookCover(input.dir, source, { git })
    return { canceled: false, snapshot }
  })

  handle('book:clearCover', async (input: { dir: string }) => clearBookCover(input.dir, { git }))

  handle('book:read', async (input: { dir: string; path: string; ref?: string }) =>
    readBookFile(input.dir, input.path, input.ref, { git }),
  )

  handle(
    'book:save',
    async (input: { dir: string; path: string; content: string; message?: string }) =>
      saveBookFile(input.dir, input.path, input.content, input.message, { git }),
  )

  handle('proposals:list', async (input: { dir: string }) => {
    const proposals = listKnowledgeProposals(input.dir)
    return Promise.all(
      proposals.map(async (proposal) => ({
        ...proposal,
        currentContent: (
          await readBookFile(input.dir, proposal.targetPath, undefined, { git })
        ).content,
      })),
    )
  })

  handle('proposals:accept', async (input: { dir: string; id: string }) => {
    const accepted = await acceptKnowledgeProposal(input.dir, input.id, { git })
    return {
      oid: accepted.oid,
      path: accepted.path,
      snapshot: await snapshotBook(input.dir, { git }),
    }
  })

  handle('proposals:reject', async (input: { dir: string; id: string }) => ({
    removed: rejectKnowledgeProposal(input.dir, input.id),
  }))

  handle('drafts:list', async (input: { dir: string; chapterKey: string }) =>
    listDrafts(input.dir, input.chapterKey),
  )

  handle(
    'drafts:save',
    async (input: {
      dir: string
      chapterKey: string
      content: string
      source?: 'ai' | 'human' | 'seed'
      model?: string
      note?: string
    }) =>
      saveDraft(input.dir, input.chapterKey, input.content, {
        source: input.source,
        model: input.model,
        note: input.note,
      }),
  )

  handle('drafts:read', async (input: { dir: string; chapterKey: string; version: number }) => {
    const version = readDraft(input.dir, input.chapterKey, input.version)
    return { content: version.content, info: version }
  })

  handle('drafts:discard', async (input: { dir: string; chapterKey: string }) => {
    discardDrafts(input.dir, input.chapterKey)
    return { snapshot: await snapshotBook(input.dir, { git }) }
  })

  handle('drafts:seed', async (input: { dir: string; chapterKey: string }) =>
    seedDraft(input.dir, input.chapterKey, { git }),
  )

  handle(
    'drafts:promote',
    async (input: { dir: string; chapterKey: string; title: string; note?: string }) =>
      promoteDraft(input.dir, input.chapterKey, input.title, { git, note: input.note }),
  )

  handle('chapters:create', async (input: { dir: string; title?: string }) =>
    createChapterDraft(input.dir, input.title, { git }),
  )

  handle('chapters:list', async (input: { dir: string }) => listChapters(input.dir))

  handle('git:history', async (input: { dir: string; depth?: number }) =>
    git.log(input.dir, { depth: input.depth ?? 100 }),
  )

  handle('git:fileHistory', async (input: { dir: string; path: string; depth?: number }) =>
    git.log(input.dir, { depth: input.depth ?? 50, filepath: input.path }),
  )

  handle('git:diff', async (input: { dir: string; from: string; to: string }) =>
    git.diff(input.dir, input.from, input.to),
  )

  handle('git:rollback', async (input: { dir: string; oid: string }) => {
    const result = await git.restoreTo(input.dir, input.oid)
    return { oid: result.oid, restoredFrom: input.oid, changedFiles: result.changedFiles }
  })

  handle('agent:ensure', async (input: { dir: string; title: string }) =>
    agentManager.ensure(input.dir, input.title),
  )

  handle(
    'agent:send',
    async (input: { dir: string; title: string; text: string; chapterKey?: string }) => {
      await agentManager.send(input.dir, input.title, input.text, input.chapterKey)
      return { accepted: true }
    },
  )

  handle('agent:session', async (input: { dir: string }) => {
    const session = loadSession(path.join(input.dir, '.studio', 'agent', 'session.json'))
    return toChatHistory(session.messages)
  })

  handle('agent:info', async () => agentManager.info)

  handle('chapters:delete', async (input: { dir: string; chapterKey: string }) => {
    const result = await deleteChapter(input.dir, input.chapterKey, { git })
    return result
  })

  const stopAgentBeforeReorg = (): void => {
    agentManager.abort()
  }

  handle('chapters:renumber', async (input: { dir: string }) => {
    stopAgentBeforeReorg()
    return renumberChapters(input.dir, { git })
  })

  handle(
    'chapters:move',
    async (input: { dir: string; chapterKey: string; direction: 'up' | 'down' }) => {
      stopAgentBeforeReorg()
      return moveChapter(input.dir, input.chapterKey, input.direction, { git })
    },
  )

  handle(
    'chapters:insertAfter',
    async (input: { dir: string; afterKey: string | null; title: string; content?: string }) => {
      stopAgentBeforeReorg()
      return insertChapterAfter(input.dir, input.afterKey, { title: input.title, content: input.content }, { git })
    },
  )

  handle(
    'chapters:mergeNext',
    async (input: { dir: string; chapterKey: string }) => {
      stopAgentBeforeReorg()
      return mergeChapterIntoNext(input.dir, input.chapterKey, { git })
    },
  )

  handle(
    'chapters:split',
    async (input: { dir: string; chapterKey: string; offset: number }) => {
      stopAgentBeforeReorg()
      return splitChapter(input.dir, input.chapterKey, input.offset, { git })
    },
  )

  handle('books:delete', async (input: { dir: string }) => {
    const workspace = workspaceRoot()
    return trashBook(workspace, input.dir)
  })

  handle('books:importFile', async (input: { dir: string; filePath?: string }) => {
    let filePath = input.filePath
    if (!filePath) {
      const result = await dialog.showOpenDialog({
        title: '导入小说文本',
        properties: ['openFile'],
        filters: [
          { name: '文本文件', extensions: ['txt', 'md', 'text'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true as const }
      filePath = result.filePaths[0]
    }
    const { snapshot, report } = await importFileIntoBook(input.dir, filePath)
    return { canceled: false as const, snapshot, report }
  })

  handle('books:importFiles', async (input: { dir: string; filePaths?: string[] }) => {
    let filePaths = input.filePaths
    if (!filePaths || filePaths.length === 0) {
      const result = await dialog.showOpenDialog({
        title: '批量导入小说文本（可多选）',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '文本文件', extensions: ['txt', 'md', 'text'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true as const }
      filePaths = result.filePaths
    }
    const { snapshot, report } = await importManyFilesIntoBook(input.dir, filePaths)
    return { canceled: false as const, snapshot, report }
  })

  handle(
    'books:importText',
    async (input: { dir: string; text: string; title?: string }) => {
      const title = input.title?.trim() || '粘贴文本'
      const { snapshot, report } = await importTextIntoBook(input.dir, {
        text: input.text,
        source: title,
        fallbackTitle: title,
      })
      return { canceled: false as const, snapshot, report }
    },
  )

  handle('style:drift', async (input: { dir: string; path: string; content?: string }) => {
    const text =
      typeof input.content === 'string'
        ? input.content
        : await readBookFile(input.dir, input.path)
            .then((file) => file.content)
            .catch(() => '')
    const current = computeStyleMetrics([{ content: text }])
    const fingerprintPath = path.join(input.dir, 'style_fingerprint.md')
    if (!fs.existsSync(fingerprintPath)) {
      return { hasFingerprint: false, baseline: {}, current, warnings: [] }
    }
    const baseline = parseFingerprintMetrics(fs.readFileSync(fingerprintPath, 'utf8'))
    return { hasFingerprint: true, baseline, current, warnings: compareStyleMetrics(baseline, current) }
  })

  handle('tomato:status', async () => ensureTomatoAvailable())

  handle('tomato:search', async (input: { query: string; count?: number }) =>
    searchTomatoBooks(input.query, input.count ?? 10),
  )

  handle('tomato:import', async (input: { dir: string; bookId: string; title: string }) => {
    const { snapshot, report } = await importTomatoBook(
      input.dir,
      { bookId: input.bookId, title: input.title },
      (progress) => sendToWindow('tomato:progress', progress),
    )
    return { snapshot, report }
  })

  handle('agent:steer', async (input: { text: string }) => {
    agentManager.steer(input.text)
    return { accepted: true }
  })

  handle('agent:abort', async () => {
    agentManager.abort()
    return { accepted: true }
  })

  handle('agent:compact', async () => {
    agentManager.compact()
    return { accepted: true }
  })

  handle('agent:reset', async () => {
    agentManager.reset()
    return { accepted: true }
  })

  handle('pipeline:plan', async (input: { dir: string }) => planKnowledgeUpdate(input.dir))

  handle('outline:start', async (input: { dir: string; title: string; premise: string; volumes?: number }) => {
    outlineManager.start(input)
    return { started: true }
  })

  handle('outline:cancel', async () => {
    outlineManager.cancel()
    reviewManager.cancel()
    return { canceled: true }
  })

  handle(
    'review:start',
    async (input: { dir: string; title: string; fromChapter?: number; toChapter?: number; focus?: string }) => {
      reviewManager.start(input)
      return { started: true }
    },
  )

  handle('review:cancel', async () => {
    reviewManager.cancel()
    return { canceled: true }
  })

  handle('pipeline:start', async (input: { dir: string; title: string }) => {
    pipelineManager.start(input)
    return { started: true }
  })

  handle('pipeline:cancel', async () => {
    pipelineManager.cancel()
    return { canceled: true }
  })

  handle('pipeline:status', async () => ({ running: pipelineManager.isRunning }))

  handle('settings:get', async () => getSettings())

  handle('settings:testConnection', async () => testModelConnection())

  handle('settings:save', async (input: SettingsSaveInput) => {
    const previousProxy = getProxyUrl()
    const next = saveSettings(input)
    // 模型/密钥变了：销毁 Host，下次使用时按新配置重建
    agentManager.dispose()
    if (previousProxy !== next.proxyUrl) applySessionProxy()
    if (next.autoBackup) setTimeout(() => maybeAutoBackup(), 800)
    return next
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#f7f2e8',
    title: 'Novel Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    getLogger().error('渲染进程退出', details)
    void dialog
      .showMessageBox({
        type: 'error',
        title: '界面进程异常退出',
        message: '界面进程异常退出，已记录日志。',
        detail: `reason: ${details.reason}`,
        buttons: ['重新加载', '退出'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) mainWindow?.reload()
        else app.quit()
      })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // 关窗即停止后台推流，避免继续烧 token
    agentManager.abort()
    pipelineManager.cancel()
    outlineManager.cancel()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 启动后静默检查一次更新（仅打包版）；发现新版本通过 update:event 提示
  if (!updateChecked) {
    updateChecked = true
    setTimeout(() => {
      void updateManager.check().catch(() => {
        // 检查更新失败不打扰用户
      })
    }, 8_000)
  }
}

app.on('child-process-gone', (_event, details) => {
  getLogger().warn('子进程退出', { type: details.type, reason: details.reason, exitCode: details.exitCode })
})

app.whenReady().then(() => {
  initLogger(app.getPath('userData'))
  getLogger().info('应用启动', { version: app.getVersion(), platform: process.platform, electron: process.versions.electron })
  loadLocalEnv()
  applySessionProxy()

  // 数据 schema：升级失败不影响应用启动，但要留下可诊断的日志/提示
  try {
    const schema = ensureAllSchemas(workspaceRoot())
    getLogger().info('数据 schema 检查完成', {
      workspace: schema.workspace.version,
      books: schema.books,
      migratedBooks: schema.migratedBooks,
      errors: schema.errors.length,
    })
    if (schema.errors.length > 0) {
      getLogger().warn('数据 schema 升级失败', { errors: schema.errors })
      const workspaceError = schema.errors.find((item) => item.book === 'workspace')
      if (workspaceError) dialog.showErrorBox('工作区数据版本不兼容', workspaceError.error)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    getLogger().error('工作区数据版本检查失败', { error: message })
    dialog.showErrorBox('数据版本不兼容', message)
  }

  registerIpc()
  createWindow()
  setTimeout(() => maybeAutoBackup(), 9_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  agentManager.dispose()
  pipelineManager.dispose()
  outlineManager.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  agentManager.dispose()
  outlineManager.dispose()
})
