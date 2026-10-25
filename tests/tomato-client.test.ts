import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectTomato,
  downloadTomatoBook,
  searchTomato,
  type TomatoJobProgress,
} from '../src/main/tomato-client'

const state = {
  polls: 0,
  fail: false,
  saveDir: '',
  jobCreated: false,
}

let server: http.Server
let port = 0

function json(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, { save_dir: state.saveDir, version: 'stub-1.0' })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const query = url.searchParams.get('q') ?? ''
      json(res, {
        items: [
          { book_id: '7301', book_name: `搜索：${query}`, author: '作者甲' },
          { id: 7302, title: '别名书', author_name: '作者乙' },
          { book_name: '缺 id 的脏数据' },
        ],
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      json(res, { ok: true })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      state.jobCreated = true
      json(res, { id: 1 })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      state.polls += 1
      if (state.fail) {
        json(res, { items: [{ id: 1, state: 'failed', message: '书源不可用' }] })
        return
      }
      if (!state.jobCreated) {
        json(res, { items: [] })
        return
      }
      if (state.polls < 2) {
        json(res, { items: [{ id: 1, state: 'running', progress: { saved_chapters: 2, chapter_total: 10 } }] })
        return
      }
      // 完成时把 txt 落到 save_dir
      fs.writeFileSync(path.join(state.saveDir, '测试书.txt'), '第一章 雾夜渡客\n\n雾从水面长出来。\n', 'utf8')
      json(res, { items: [{ id: 1, state: 'done', progress: { saved_chapters: 10, chapter_total: 10 } }] })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  port = address.port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('番茄下载器适配', () => {
  it('可用时返回 saveDir 与版本', async () => {
    const status = await detectTomato(`http://127.0.0.1:${port}`)
    expect(status.available).toBe(true)
    expect(status.baseUrl).toBe(`http://127.0.0.1:${port}`)
    expect(status.version).toBe('stub-1.0')
  })

  it('不可用时快速返回 available=false', async () => {
    const status = await detectTomato('http://127.0.0.1:9', 300)
    expect(status.available).toBe(false)
  })

  it('搜索会跳过缺字段的脏数据并兼容多种字段名', async () => {
    const books = await searchTomato('雾海', { baseUrl: `http://127.0.0.1:${port}` })
    expect(books.map((book) => book.bookId)).toEqual(['7301', '7302'])
    expect(books[0].title).toBe('搜索：雾海')
    expect(books[0].author).toBe('作者甲')
    expect(books[1].title).toBe('别名书')
  })

  it('下载流程：配置目录 → 提交任务 → 轮询 → 找到 txt', async () => {
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-save-'))
    state.saveDir = saveDir
    state.polls = 0
    state.fail = false
    state.jobCreated = false
    const progress: TomatoJobProgress[] = []

    const result = await downloadTomatoBook({
      bookId: '7301',
      saveDir,
      baseUrl: `http://127.0.0.1:${port}`,
      pollIntervalMs: 20,
      onProgress: (item) => progress.push(item),
    })

    expect(result.txtPath.endsWith('测试书.txt')).toBe(true)
    expect(fs.existsSync(result.txtPath)).toBe(true)
    expect(progress.some((item) => item.state === 'running' && item.saved === 2)).toBe(true)
    expect(progress.some((item) => item.state === 'done')).toBe(true)
    fs.rmSync(saveDir, { recursive: true, force: true })
  })

  it('任务失败时抛出带原因的异常', async () => {
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-fail-'))
    state.saveDir = saveDir
    state.polls = 0
    state.fail = true
    state.jobCreated = false
    await expect(
      downloadTomatoBook({
        bookId: 'bad',
        saveDir,
        baseUrl: `http://127.0.0.1:${port}`,
        pollIntervalMs: 20,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow('书源不可用')
    fs.rmSync(saveDir, { recursive: true, force: true })
  })
})
