import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, FileText, Loader2, Sparkles, X } from 'lucide-react'
import type { BookSnapshot, KnowledgeProposalInfo } from '@shared/types'
import { studio, unwrap } from '../lib/api'
import { diffStat, renderWordDiff } from '../lib/diff'
import { useDialog } from '../lib/useDialog'

interface Props {
  dir: string
  notify: (text: string, error?: boolean) => void
  onClose: () => void
  onAccepted: (snapshot: BookSnapshot) => void
}

/** AI 知识建议：看 diff → 接受（写入正史 + Git 提交）或拒绝（丢弃） */
export default function ProposalsModal({ dir, notify, onClose, onAccepted }: Props) {
  const dialogRef = useDialog(true, onClose)

  const [proposals, setProposals] = useState<KnowledgeProposalInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<KnowledgeProposalInfo[]> => {
    setLoading(true)
    try {
      const list = await unwrap(studio.proposals.list({ dir }))
      setProposals(list)
      setSelectedId((current) => {
        if (current && list.some((item) => item.id === current)) return current
        return list[0]?.id ?? null
      })
      setError('')
      return list
    } catch (err) {
      setError((err as Error).message)
      return []
    } finally {
      setLoading(false)
    }
  }, [dir])

  useEffect(() => {
    void load()
  }, [load])

  const selected = useMemo(
    () => proposals.find((item) => item.id === selectedId) ?? null,
    [proposals, selectedId],
  )

  const accept = async () => {
    if (!selected || busy) return
    setBusy(true)
    try {
      const result = await unwrap(studio.proposals.accept({ dir, id: selected.id }))
      notify(`已采纳「${selected.targetTitle}」建议${result.oid ? '，并提交到正史' : '（内容无变化）'}`)
      onAccepted(result.snapshot)
      const list = await load()
      if (list.length === 0) onClose()
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    if (!selected || busy) return
    setBusy(true)
    try {
      await unwrap(studio.proposals.reject({ dir, id: selected.id }))
      notify(`已拒绝「${selected.targetTitle}」建议`)
      await load()
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const stat = selected ? diffStat(selected.currentContent, selected.content) : { added: 0, removed: 0 }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal modal--wide" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <Sparkles size={17} style={{ color: 'var(--accent)' }} />
          <div className="modal__title">AI 知识建议</div>
          <div className="doc-header__sub">AI 只写建议，你确认后才会进入正史</div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body proposals">
          <aside className="proposals__list">
            {loading && <div className="panel-hint">加载中…</div>}
            {!loading && proposals.length === 0 && (
              <div className="empty">还没有建议。Agent 在大纲/设定上需要改进时，会给你一份可审阅的建议。</div>
            )}
            {proposals.map((proposal) => (
              <button
                key={proposal.id}
                className={`proposals__item${proposal.id === selectedId ? ' is-active' : ''}`}
                onClick={() => setSelectedId(proposal.id)}
              >
                <span className="proposals__title">
                  <FileText size={14} />
                  {proposal.targetTitle}
                </span>
                <span className="proposals__meta">
                  {proposal.source === 'outline' ? '大纲向导' : 'Agent'} ·{' '}
                  {new Date(proposal.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </button>
            ))}
          </aside>
          <section className="proposals__detail">
            {error && <div className="panel-hint panel-hint--error">{error}</div>}
            {!selected && !loading && <div className="empty">选择左侧建议查看差异</div>}
            {selected && (
              <>
                <div className="proposals__head">
                  <div>
                    <div className="proposals__file">{selected.targetPath}</div>
                    {selected.reason && <div className="proposals__reason">理由：{selected.reason}</div>}
                  </div>
                  <div className="proposals__stat">
                    <span className="diff-ins">+{stat.added}</span> / <span className="diff-del">-{stat.removed}</span>
                  </div>
                </div>
                <div
                  className="proposals__diff"
                  dangerouslySetInnerHTML={{
                    __html: renderWordDiff(selected.currentContent, selected.content),
                  }}
                />
                <div className="proposals__actions">
                  <button className="danger" onClick={() => void reject()} disabled={busy}>
                    {busy ? <Loader2 size={14} className="spin" /> : <X size={14} />}
                    拒绝
                  </button>
                  <button onClick={() => void accept()} disabled={busy}>
                    {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                    接受并提交
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
