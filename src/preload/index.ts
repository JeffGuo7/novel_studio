import { contextBridge, ipcRenderer } from 'electron'
import type { StudioApi } from '../shared/types'

const invoke = <T>(channel: string, payload: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>

const api: StudioApi = {
  listBooks: () => invoke('workspace:list', undefined),
  createBook: (input) => invoke('workspace:create', input),
  openBook: (dir) => invoke('book:open', { dir }),
  readFile: (input) => invoke('book:read', input),
  saveFile: (input) => invoke('book:save', input),
  listDrafts: (input) => invoke('drafts:list', input),
  saveDraft: (input) => invoke('drafts:save', input),
  readDraft: (input) => invoke('drafts:read', input),
  discardDrafts: (input) => invoke('drafts:discard', input),
  promoteDraft: (input) => invoke('drafts:promote', input),
  seedDraft: (input) => invoke('drafts:seed', input),
  listChapters: (input) => invoke('chapters:list', input),
  createChapter: (input) => invoke('chapters:create', input),
  history: (input) => invoke('git:history', input),
  fileHistory: (input) => invoke('git:fileHistory', input),
  diff: (input) => invoke('git:diff', input),
  rollback: (input) => invoke('git:rollback', input),
  deleteBook: (input) => invoke('books:delete', input),
  deleteChapter: (input) => invoke('chapters:delete', input),
  renumberChapters: (input) => invoke('chapters:renumber', input),
  moveChapter: (input) => invoke('chapters:move', input),
  insertChapterAfter: (input) => invoke('chapters:insertAfter', input),
  mergeChapterIntoNext: (input) => invoke('chapters:mergeNext', input),
  splitChapter: (input) => invoke('chapters:split', input),
  importFile: (input) => invoke('books:importFile', input),
  importFiles: (input) => invoke('books:importFiles', input),
  importText: (input) => invoke('books:importText', input),
  outline: {
    start: (input) => invoke('outline:start', input),
    cancel: () => invoke('outline:cancel', undefined),
    onEvent: (handler) => {
      const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload)
      ipcRenderer.on('outline:event', listener as never)
      return () => {
        ipcRenderer.removeListener('outline:event', listener as never)
      }
    },
  },
  update: {
    check: () => invoke('update:check', undefined),
    download: () => invoke('update:download', undefined),
    install: () => invoke('update:install', undefined),
    openPage: () => invoke('update:openPage', undefined),
    onEvent: (handler) => {
      const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload)
      ipcRenderer.on('update:event', listener as never)
      return () => {
        ipcRenderer.removeListener('update:event', listener as never)
      }
    },
  },
  backup: {
    export: (input) => invoke('backup:export', input),
    restore: (input) => invoke('backup:restore', input),
    health: () => invoke('backup:health', undefined),
  },
  exportBook: (input) => invoke('export:book', input),
  search: {
    book: (input) => invoke('search:book', input),
    replace: (input) => invoke('search:replace', input),
  },
  autosave: {
    list: (input) => invoke('autosave:list', input),
    write: (input) => invoke('autosave:write', input),
    discard: (input) => invoke('autosave:discard', input),
  },
  proposals: {
    list: (input) => invoke('proposals:list', input),
    accept: (input) => invoke('proposals:accept', input),
    reject: (input) => invoke('proposals:reject', input),
  },
  tomato: {
    status: () => invoke('tomato:status', undefined),
    search: (input) => invoke('tomato:search', input),
    import: (input) => invoke('tomato:import', input),
    onProgress: (handler) => {
      const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload)
      ipcRenderer.on('tomato:progress', listener as never)
      return () => {
        ipcRenderer.removeListener('tomato:progress', listener as never)
      }
    },
  },
  workspaceRoot: () => invoke('workspace:root', undefined),
  style: {
    drift: (input) => invoke('style:drift', input),
  },
  app: {
    info: () => invoke('app:info', undefined),
    openDir: (input) => invoke('app:openDir', input),
    log: (input) => invoke('app:log', input),
    revealFile: (input) => invoke('app:revealFile', input),
  },
  agent: {
    ensure: (input) => invoke('agent:ensure', input),
    send: (input) => invoke('agent:send', input),
    loadSession: (input) => invoke('agent:session', input),
    info: () => invoke('agent:info', undefined),
    steer: (input) => invoke('agent:steer', input),
    abort: () => invoke('agent:abort', undefined),
    reset: () => invoke('agent:reset', undefined),
    compact: () => invoke('agent:compact', undefined),
    onEvent: (handler) => {
      const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload)
      ipcRenderer.on('agent:event', listener as never)
      return () => {
        ipcRenderer.removeListener('agent:event', listener as never)
      }
    },
  },
  pipeline: {
    plan: (input) => invoke('pipeline:plan', input),
    start: (input) => invoke('pipeline:start', input),
    cancel: () => invoke('pipeline:cancel', undefined),
    onEvent: (handler) => {
      const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload)
      ipcRenderer.on('pipeline:event', listener as never)
      return () => {
        ipcRenderer.removeListener('pipeline:event', listener as never)
      }
    },
  },
  settings: {
    get: () => invoke('settings:get', undefined),
    save: (input) => invoke('settings:save', input),
  },
}

contextBridge.exposeInMainWorld('studio', api)
