import fs from 'node:fs'
import path from 'node:path'
import git from 'isomorphic-git'
import type { CommitInfo, FileDiff } from '../shared/types'
import { CoreError } from './errors'
import { ensureDir, readFileOrNull, removeFile, writeFileAtomic } from './fsutil'

const AUTHOR = { name: 'Novel Studio', email: 'studio@local' }
const decoder = new TextDecoder('utf-8')

export type FileChangeStatus = 'added' | 'modified' | 'deleted'

export interface FileChange {
  path: string
  status: FileChangeStatus
}

/**
 * GitPort：把版本控制抽象成领域接口。
 * 当前实现是 isomorphic-git（纯 JS、零外部依赖）；
 * 若将来某些边缘情况需要真 git，可加 ExternalGitPort（dugite）而不改上层。
 */
export interface GitPort {
  isRepo(dir: string): Promise<boolean>
  init(dir: string): Promise<void>
  /**
   * 提交指定路径（force add，绕过 stat 缓存）。
   * 不用 fs 扫描推导变更：isomorphic-git 的 statusMatrix 依赖 size+mtime 快速判断，
   * 同长度、同秒内的修改会被漏检（实测），所以调用方必须显式给出变更路径。
   */
  commitPaths(dir: string, paths: string[], message: string): Promise<string | null>
  status(dir: string): Promise<FileChange[]>
  log(dir: string, opts?: { depth?: number; filepath?: string }): Promise<CommitInfo[]>
  head(dir: string): Promise<string | null>
  currentBranch(dir: string): Promise<string | null>
  filesAt(dir: string, ref: string): Promise<Map<string, string>>
  readFileAt(dir: string, ref: string, filepath: string): Promise<string | null>
  diff(dir: string, from: string, to: string): Promise<FileDiff[]>
  restoreTo(dir: string, ref: string): Promise<{ oid: string | null; changedFiles: number }>
}

function splitMessage(message: string): { summary: string; kind: string } {
  const firstLine = message.split('\n')[0]?.trim() ?? ''
  const match = firstLine.match(/^\[([^\]]+)\]\s*(.*)$/)
  if (match) return { kind: match[1].trim(), summary: match[2].trim() }
  return { kind: '其他', summary: firstLine }
}

function toCommitInfo(raw: {
  oid: string
  commit: {
    message?: string
    author?: { name?: string; timestamp?: number }
    parent?: string[]
  }
}): CommitInfo {
  const message = raw.commit.message ?? ''
  const { summary, kind } = splitMessage(message)
  return {
    oid: raw.oid,
    short: raw.oid.slice(0, 7),
    message: message.trim(),
    summary,
    kind,
    timestamp: (raw.commit.author?.timestamp ?? 0) * 1000,
    author: raw.commit.author?.name ?? 'unknown',
    parents: raw.commit.parent ?? [],
  }
}

/** 递归收集某棵树下的所有 blob：path -> blob oid */
async function collectTree(
  dir: string,
  treeOid: string,
  prefix = '',
  out = new Map<string, string>(),
): Promise<Map<string, string>> {
  const { tree } = await git.readTree({ fs, dir, oid: treeOid })
  for (const entry of tree) {
    const entryPath = prefix ? `${prefix}/${entry.path}` : entry.path
    if (entry.type === 'tree') {
      await collectTree(dir, entry.oid, entryPath, out)
    } else if (entry.type === 'blob') {
      out.set(entryPath, entry.oid)
    }
  }
  return out
}

async function resolveCommitTree(dir: string, ref: string): Promise<string> {
  const oid = await git.resolveRef({ fs, dir, ref })
  const { commit } = await git.readCommit({ fs, dir, oid })
  return commit.tree
}

async function readBlobText(dir: string, blobOid: string): Promise<string> {
  const { blob } = await git.readBlob({ fs, dir, oid: blobOid })
  return decoder.decode(blob)
}

async function resolveBlobOid(
  dir: string,
  treeOid: string,
  filepath: string,
): Promise<string | null> {
  const parts = filepath.split('/').filter(Boolean)
  let currentTree = treeOid
  for (let i = 0; i < parts.length; i += 1) {
    const { tree } = await git.readTree({ fs, dir, oid: currentTree })
    const entry = tree.find((item) => item.path === parts[i])
    if (!entry) return null
    const isLast = i === parts.length - 1
    if (isLast) return entry.type === 'blob' ? entry.oid : null
    if (entry.type !== 'tree') return null
    currentTree = entry.oid
  }
  return null
}

export class IsoGitPort implements GitPort {
  async isRepo(dir: string): Promise<boolean> {
    try {
      await git.resolveRef({ fs, dir, ref: 'HEAD' })
      return true
    } catch {
      // 空仓库没有 HEAD 指向，退一步看 .git 是否存在
      return fs.existsSync(path.join(dir, '.git'))
    }
  }

  async init(dir: string): Promise<void> {
    ensureDir(dir)
    await git.init({ fs, dir, defaultBranch: 'main' })
  }

  async commitPaths(dir: string, paths: string[], message: string): Promise<string | null> {
    const unique = [...new Set(paths.filter(Boolean))]
    if (unique.length === 0) return null
    for (const filepath of unique) {
      const absolute = path.join(dir, filepath)
      if (fs.existsSync(absolute)) {
        await git.add({ fs, dir, filepath, force: true })
      } else {
        try {
          await git.remove({ fs, dir, filepath })
        } catch {
          // 文件在 HEAD 里也不存在时 remove 可能报错，忽略
        }
      }
    }
    try {
      return await git.commit({ fs, dir, message, author: AUTHOR })
    } catch (err) {
      if (err instanceof Error && /nothing to commit|empty/i.test(err.message)) return null
      throw err
    }
  }

  async status(dir: string): Promise<FileChange[]> {
    const rows = (await git.statusMatrix({ fs, dir })) as unknown as Array<
      [string, number, number, number]
    >
    const changes: FileChange[] = []
    for (const [filepath, head, workdir] of rows) {
      if (head === 1 && workdir === 1) continue
      if (workdir === 0 && head > 0) changes.push({ path: filepath, status: 'deleted' })
      else if (head === 0 && workdir > 0) changes.push({ path: filepath, status: 'added' })
      else if (workdir > 0) changes.push({ path: filepath, status: 'modified' })
    }
    return changes
  }

  async log(
    dir: string,
    opts: { depth?: number; filepath?: string } = {},
  ): Promise<CommitInfo[]> {
    try {
      const commits = await git.log({
        fs,
        dir,
        depth: opts.depth ?? 50,
        ...(opts.filepath ? { filepath: opts.filepath } : {}),
      })
      return commits.map((item) => toCommitInfo(item as never))
    } catch (err) {
      // 空仓库（还没有任何提交）
      if (err instanceof Error && /not\s*found|Could not find/i.test(err.message)) return []
      throw err
    }
  }

  async head(dir: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs, dir, ref: 'HEAD' })
    } catch {
      return null
    }
  }

  async currentBranch(dir: string): Promise<string | null> {
    try {
      const branch = await git.currentBranch({ fs, dir, fullname: false })
      return branch ?? null
    } catch {
      return null
    }
  }

  async filesAt(dir: string, ref: string): Promise<Map<string, string>> {
    const tree = await resolveCommitTree(dir, ref)
    return collectTree(dir, tree)
  }

  async readFileAt(dir: string, ref: string, filepath: string): Promise<string | null> {
    const tree = await resolveCommitTree(dir, ref)
    const blobOid = await resolveBlobOid(dir, tree, filepath)
    if (!blobOid) return null
    return readBlobText(dir, blobOid)
  }

  async diff(dir: string, from: string, to: string): Promise<FileDiff[]> {
    const beforeMap = await this.filesAt(dir, from)
    const afterMap = await this.filesAt(dir, to)
    const paths = new Set<string>([...beforeMap.keys(), ...afterMap.keys()])
    const diffs: FileDiff[] = []
    for (const filepath of [...paths].sort()) {
      const beforeOid = beforeMap.get(filepath)
      const afterOid = afterMap.get(filepath)
      if (beforeOid === afterOid) continue
      diffs.push({
        path: filepath,
        before: beforeOid ? await readBlobText(dir, beforeOid) : null,
        after: afterOid ? await readBlobText(dir, afterOid) : null,
      })
    }
    return diffs
  }

  async restoreTo(dir: string, ref: string): Promise<{ oid: string | null; changedFiles: number }> {
    const targetMap = await this.filesAt(dir, ref)
    let headMap = new Map<string, string>()
    try {
      headMap = await this.filesAt(dir, 'HEAD')
    } catch {
      headMap = new Map()
    }

    const changedPaths: string[] = []
    for (const [filepath, blobOid] of targetMap) {
      const content = await readBlobText(dir, blobOid)
      const targetPath = path.join(dir, filepath)
      if (readFileOrNull(targetPath) === content) continue
      ensureDir(path.dirname(targetPath))
      writeFileAtomic(targetPath, content)
      changedPaths.push(filepath)
    }
    for (const filepath of headMap.keys()) {
      if (targetMap.has(filepath)) continue
      if (removeFile(path.join(dir, filepath))) changedPaths.push(filepath)
    }

    if (changedPaths.length === 0) return { oid: null, changedFiles: 0 }
    const oid = await this.commitPaths(dir, changedPaths, `[还原] 还原到 ${ref.slice(0, 7)}`)
    return { oid, changedFiles: changedPaths.length }
  }
}

export function createGitPort(): GitPort {
  return new IsoGitPort()
}
