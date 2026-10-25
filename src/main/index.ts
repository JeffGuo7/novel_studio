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
} from '../core'
import type { Result } from '../shared/types'
import type { SettingsSaveInput } from '../shared/model-config'
import { loadSession } from '../agent/session-store'
import { toChatHistory } from '../agent/session-state'
import { AgentManager } from './agent-manager'
import { getSettings, saveSettings } from './settings-store'

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

const agentManager = new AgentManager((event) => {
  mainWindow?.webContents.send('agent:event', event)
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

  handle('agent:steer', async (input: { text: string }) => {
    agentManager.steer(input.text)
    return { accepted: true }
  })

  handle('agent:abort', async () => {
    agentManager.abort()
    return { accepted: true }
  })

  handle('agent:reset', async () => {
    agentManager.reset()
    return { accepted: true }
  })

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
    backgroundColor: '#0f1115',
    title: 'Novel Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
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
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  agentManager.dispose()
})
