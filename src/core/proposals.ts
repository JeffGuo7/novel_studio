/**
 * AI 知识建议（proposal）。
 *
 * Agent 不能直接改知识文件——它只能写"建议"到 `.studio/proposals/<id>.json`，
 * 由作者在 UI 里看 diff、点「接受」后才落到正史（并产生一条 Git 提交）。
 * 这是"AI 可提议、人拍板"的产品红线的一部分。
 */
import fs from 'node:fs'
import path from 'node:path'
import { KNOWLEDGE_FILES, KNOWLEDGE_NAMES, saveBookFile, type BookServiceOptions } from './book'
import { CoreError } from './errors'
import { ensureDir, removeFile, writeFileAtomic } from './fsutil'

export interface KnowledgeProposalInput {
  /** 目标知识文件名（白名单），如 master_outline.md */
  targetPath: string
  content: string
  /** 一句话说明为什么要改 */
  reason?: string
  /** 建议来源：Agent / 大纲向导 / 知识管线 */
  source?: 'agent' | 'outline' | 'pipeline'
}

export interface KnowledgeProposalInfo {
  id: string
  targetPath: string
  targetTitle: string
  content: string
  reason: string
  source: 'agent' | 'outline' | 'pipeline'
  createdAt: string
}

const ID_RE = /^p-[0-9a-z]+-[0-9a-z]{4,16}$/
const MAX_CONTENT_CHARS = 400_000
const MAX_REASON_CHARS = 600

export function proposalsDir(bookDir: string): string {
  return path.join(bookDir, '.studio', 'proposals')
}

function proposalPath(bookDir: string, id: string): string {
  if (!ID_RE.test(id)) throw new CoreError('PATH_REJECTED', `非法的建议 id: ${id}`)
  return path.join(proposalsDir(bookDir), `${id}.json`)
}

function titleOf(targetPath: string): string {
  return KNOWLEDGE_FILES.find((file) => file.name === targetPath)?.title ?? targetPath
}

function assertTarget(targetPath: string): string {
  const normalized = String(targetPath ?? '')
    .replace(/\\/g, '/')
    .trim()
  if (!KNOWLEDGE_NAMES.has(normalized)) {
    throw new CoreError(
      'PATH_REJECTED',
      `只能对知识文件提建议（${[...KNOWLEDGE_NAMES].join(', ')}），不能改章节或其它路径`,
    )
  }
  return normalized
}

export function createKnowledgeProposal(
  bookDir: string,
  input: KnowledgeProposalInput,
): KnowledgeProposalInfo {
  const targetPath = assertTarget(input.targetPath)
  const content = String(input.content ?? '')
  if (!content.trim()) throw new CoreError('INVALID_INPUT', '建议内容不能为空')
  if (content.length > MAX_CONTENT_CHARS) {
    throw new CoreError('INVALID_INPUT', `建议内容过长（上限 ${MAX_CONTENT_CHARS} 字）`)
  }
  const reason = String(input.reason ?? '')
    .trim()
    .slice(0, MAX_REASON_CHARS)
  const proposal: KnowledgeProposalInfo = {
    id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    targetPath,
    targetTitle: titleOf(targetPath),
    content,
    reason,
    source: input.source ?? 'agent',
    createdAt: new Date().toISOString(),
  }
  ensureDir(proposalsDir(bookDir))
  writeFileAtomic(
    proposalPath(bookDir, proposal.id),
    JSON.stringify(proposal, null, 2) + '\n',
  )
  return proposal
}

export function listKnowledgeProposals(bookDir: string): KnowledgeProposalInfo[] {
  const dir = proposalsDir(bookDir)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const raw = fs.readFileSync(path.join(dir, name), 'utf8')
        const parsed = JSON.parse(raw) as KnowledgeProposalInfo
        if (!parsed || typeof parsed.id !== 'string' || !ID_RE.test(parsed.id)) return []
        return [
          {
            ...parsed,
            targetTitle: parsed.targetTitle || titleOf(parsed.targetPath),
          },
        ]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function readKnowledgeProposal(
  bookDir: string,
  id: string,
): KnowledgeProposalInfo | null {
  try {
    const raw = fs.readFileSync(proposalPath(bookDir, id), 'utf8')
    const parsed = JSON.parse(raw) as KnowledgeProposalInfo
    if (!parsed || parsed.id !== id) return null
    return { ...parsed, targetTitle: parsed.targetTitle || titleOf(parsed.targetPath) }
  } catch {
    return null
  }
}

export function rejectKnowledgeProposal(bookDir: string, id: string): boolean {
  return removeFile(proposalPath(bookDir, id))
}

/**
 * 采纳建议：写入知识文件并提交一版 Git（作者确认后才发生）。
 * 返回提交 oid；如果内容与现有文件完全一致则 oid 为 null。
 */
export async function acceptKnowledgeProposal(
  bookDir: string,
  id: string,
  options: BookServiceOptions = {},
): Promise<{ proposal: KnowledgeProposalInfo; oid: string | null; path: string }> {
  const proposal = readKnowledgeProposal(bookDir, id)
  if (!proposal) throw new CoreError('NOT_FOUND', `建议不存在或已被处理：${id}`)
  const target = assertTarget(proposal.targetPath)
  const result = await saveBookFile(
    bookDir,
    target,
    proposal.content,
    `[知识] 采纳 AI 建议：${proposal.targetTitle}`,
    options,
  )
  rejectKnowledgeProposal(bookDir, id)
  return { proposal, oid: result.oid, path: target }
}
