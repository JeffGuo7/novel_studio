import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Logger } from '../src/main/logger'

function readLines(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('结构化日志', () => {
  it('按天写 JSONL，包含级别/scope/时间；Error 会被序列化', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-logger-'))
    try {
      const logger = new Logger(dir, 'test', () => new Date('2026-10-28T02:00:00.000Z'))
      logger.info('启动', { version: '0.23.0' })
      logger.warn('慢查询')
      logger.error('崩溃', new Error('boom'))
      logger.child('agent').debug('子 scope')

      const file = logger.logPath()
      expect(file.endsWith('main-2026-10-28.log')).toBe(true)
      const records = readLines(file)
      expect(records).toHaveLength(4)
      expect(records[0]).toMatchObject({ level: 'info', scope: 'test', message: '启动' })
      expect(records[0].data).toEqual({ version: '0.23.0' })
      expect(records[2].data).toMatchObject({ name: 'Error', message: 'boom' })
      expect(String((records[2].data as { stack: string }).stack)).toContain('boom')
      expect(records[3]).toMatchObject({ scope: 'test:agent', level: 'debug' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('循环数据结构不会抛错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-logger-cyclic-'))
    try {
      const logger = new Logger(dir, 'test')
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      expect(() => logger.info('cyclic', cyclic)).not.toThrow()
      const [record] = readLines(logger.logPath())
      expect(record.message).toBe('cyclic')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
