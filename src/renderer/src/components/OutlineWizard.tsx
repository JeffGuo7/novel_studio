import { useEffect, useRef, useState } from 'react'
import { Check, Lightbulb, Loader2, X } from 'lucide-react'
import { studio, unwrap } from '../lib/api'
import { useDialog } from '../lib/useDialog'

interface Props {
  open: boolean
  dir: string
  bookTitle: string
  notify: (text: string, error?: boolean) => void
  onClose: () => void
  onDone: (proposalCount: number) => void
  onViewProposals: () => void
}

/** 大纲向导：一句话创意 → 主线/篇章/世界模型建议（不直接改文件） */
export default function OutlineWizard({
  open,
  dir,
  bookTitle,
  notify,
  onClose,
  onDone,
  onViewProposals,
}: Props) {
  const [premise, setPremise] = useState('')
  const [volumes, setVolumes] = useState(3)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState('')
  const [doneCount, setDoneCount] = useState<number | null>(null)
  const [error, setError] = useState('')
  const dialogRef = useDialog(open, onClose)
  const notifyRef = useRef(notify)
  const onDoneRef = useRef(onDone)
  notifyRef.current = notify
  onDoneRef.current = onDone

  // 只在打开时重置状态（避免事件处理里的 setState 触发 effect 重跑又把状态清掉）
  useEffect(() => {
    if (!open) return
    setDoneCount(null)
    setError('')
    setMessage('')
    setRunning(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const unsubscribe = studio.outline.onEvent((event) => {
      if (event.type === 'outline_progress') {
        setMessage(event.message)
        return
      }
      if (event.type === 'outline_done') {
        setRunning(false)
        setMessage('已生成建议')
        setDoneCount(event.proposals.length)
        notifyRef.current(`大纲已生成 ${event.proposals.length} 条建议，请审阅`)
        onDoneRef.current(event.proposals.length)
        return
      }
      if (event.type === 'outline_error') {
        setRunning(false)
        setMessage('')
        setError(event.message)
        notifyRef.current(event.message, true)
      }
    })
    return unsubscribe
  }, [open])
  if (!open) return null

  const start = async () => {
    if (running) return
    if (!premise.trim()) {
      setError('先写一句创意，比如：雾海渡口的少年摆渡人，发现父亲留下的船能驶过死人留下的雾。')
      return
    }
    setRunning(true)
    setError('')
    setDoneCount(null)
    setMessage('准备中…')
    try {
      await unwrap(studio.outline.start({ dir, title: bookTitle, premise: premise.trim(), volumes }))
    } catch (err) {
      setRunning(false)
      setError((err as Error).message)
    }
  }

  const cancel = async () => {
    try {
      await unwrap(studio.outline.cancel())
    } catch {
      // ignore
    }
    setRunning(false)
    setMessage('已取消')
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal modal--outline" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <Lightbulb size={17} style={{ color: 'var(--accent)' }} />
          <div className="modal__title">大纲向导</div>
          <div className="doc-header__sub">创意 → 主线 / 分卷 / 世界模型建议</div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal__body">
          <label className="field">
            <span className="field__label">一句话创意 / 一段梗概</span>
            <textarea
              className="field__textarea"
              rows={5}
              placeholder="例：雾海渡口的少年摆渡人，发现父亲留下的旧船能驶过死人留下的雾；镇渊司正要收回所有渡船。"
              value={premise}
              onChange={(event) => setPremise(event.target.value)}
              disabled={running}
            />
          </label>
          <div className="outline__row">
            <label className="field">
              <span className="field__label">分几卷</span>
              <input
                className="field__input"
                type="number"
                min={1}
                max={8}
                value={volumes}
                onChange={(event) => setVolumes(Number(event.target.value) || 3)}
                disabled={running}
              />
            </label>
            <div className="panel-hint">
              会用当前模型生成建议；<b>不会直接改文件</b>，你在「AI 建议」里看 diff 后决定。
            </div>
          </div>
          {running && (
            <div className="outline__status">
              <Loader2 size={14} className="spin" />
              {message || '生成中…'}
              <button className="ghost btn-sm" onClick={() => void cancel()}>
                取消
              </button>
            </div>
          )}
          {error && <div className="panel-hint panel-hint--error">{error}</div>}
          {doneCount !== null && (
            <div className="outline__done">
              <Check size={15} />
              已生成 {doneCount} 条建议，可逐条审阅。
              <button
                onClick={() => {
                  onClose()
                  onViewProposals()
                }}
              >
                查看建议
              </button>
            </div>
          )}
        </div>
        <div className="modal__footer">
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
          <button onClick={() => void start()} disabled={running}>
            {running ? <Loader2 size={14} className="spin" /> : <Lightbulb size={14} />}
            {doneCount !== null ? '再生成一版' : '生成大纲建议'}
          </button>
        </div>
      </div>
    </div>
  )
}
