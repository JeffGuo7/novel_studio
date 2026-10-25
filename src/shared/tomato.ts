/** 在线书源（番茄下载器）的共享类型 */

export interface TomatoStatus {
  available: boolean
  baseUrl: string
  saveDir?: string
  version?: string
}

export interface TomatoBook {
  bookId: string
  title: string
  author?: string
}

export interface TomatoProgressEvent {
  phase: 'download' | 'import'
  saved?: number
  total?: number
  message?: string
}
