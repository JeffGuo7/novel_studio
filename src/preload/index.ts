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
  importFile: (input) => invoke('books:importFile', input),
  importFiles: (input) => invoke('books:importFiles', input),
  importText: (input) => invoke('books:importText', input),
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
  },
  agent: {
    ensure: (input) => invoke('agent:ensure', input),
    send: (input) => invoke('agent:send', input),
    loadSession: (input) => invoke('agent:session', input),
    info: () => invoke('agent:info', undefined),
    steer: (input) => invoke('agent:steer', input),
    abort: () => invoke('agent:abort', undefined),
    reset: () => invoke('agent:reset', undefined),
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
