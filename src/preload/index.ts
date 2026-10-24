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
  workspaceRoot: () => invoke('workspace:root', undefined),
}

contextBridge.exposeInMainWorld('studio', api)
