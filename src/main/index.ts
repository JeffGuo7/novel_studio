import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
} from '../core'
import type { Result } from '../shared/types'
import type { SettingsSaveInput } from '../shared/model-config'
import { loadSession } from '../agent/session-store'
import { toChatHistory } from '../agent/session-state'
import { AgentManager } from './agent-manager'
import { PipelineManager } from './pipeline-manager'
import { OutlineManager } from './outline-manager'
import { planKnowledgeUpdate } from '../pipeline/knowledge'
import { getSettings, saveSettings } from './settings-store'
import { ensureTomatoAvailable, importTomatoBook, searchTomatoBooks } from './tomato-manager'
import { compareStyleMetrics, computeStyleMetrics, parseFingerprintMetrics } from '../shared/style'

const git = createGitPort()

// 测试/隔离用：允许把 userData 指到临时目录
if (process.env.NOVEL_STUDIO_USER_DATA) {
  app.setPath('userData', process.env.NOVEL_STUDIO_USER_DATA)
}

/** 读取项目根的 .env.local（本地密钥，永不提交） */
function loadLocalEnv(): void {
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
  try {
    const file = path.join(app.getPath('userData'), 'main-error.log')
    const text =
      `[${new Date().toISOString()}] ${label}\n` +
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n\n`
    fs.appendFileSync(file, text, 'utf8')
  } catch {
    // 日志失败不能影响主流程
  }
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
  }))

  handle('app:openDir', async (input: { target: 'userData' | 'workspace' }) => {
    const target = input.target === 'userData' ? app.getPath('userData') : workspaceRoot()
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return { opened: true }
  })

  handle('workspace:list', async () => listBooks(workspaceRoot(), { git }))

  handle('workspace:create', async (input: { title: string; author?: string }) =>
    createBook(workspaceRoot(), input, { git }),
  )

  handle('book:open', async (input: { dir: string }) => snapshotBook(input.dir, { git }))

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

  handle('settings:save', async (input: SettingsSaveInput) => {
    const next = saveSettings(input)
    // 模型/密钥变了：销毁 Host，下次使用时按新配置重建
    agentManager.dispose()
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
}

app.whenReady().then(() => {
  loadLocalEnv()
  registerIpc()
  createWindow()

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
