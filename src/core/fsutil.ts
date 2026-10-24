import fs from 'node:fs'
import path from 'node:path'

/** 原子写：先写临时文件再 rename，避免半截文件 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
}

export function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** 统计"字数"：去掉空白后的字符数，对中文最直观 */
export function countWords(content: string): number {
  return content.replace(/\s+/g, '').length
}

/** 路径必须在 root 内，防止 ../ 穿越 */
export function assertInside(root: string, target: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(target)
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep
  if (resolved !== resolvedRoot && !resolved.startsWith(withSep)) {
    throw new Error(`path escapes root: ${target}`)
  }
  return resolved
}

/**
 * 删除文件。不用 fs.rmSync：Node 24.9 + Windows 对非 ASCII 路径的 rmSync
 * 会静默失败甚至触发 fail-fast 崩溃（本项目实测），unlinkSync 正常。
 */
export function removeFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false
  fs.unlinkSync(filePath)
  return true
}

/** 递归删除目录（同上，避开 rmSync） */
export function removeDirRecursive(dir: string): boolean {
  if (!fs.existsSync(dir)) return false
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) removeDirRecursive(target)
    else fs.unlinkSync(target)
  }
  fs.rmdirSync(dir)
  return true
}
