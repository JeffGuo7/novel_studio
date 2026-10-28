import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Flame, Loader2, Save, Target, X } from 'lucide-react'
import type { WritingStatsSummary } from '@shared/types'
import { studio, unwrap } from '../lib/api'
import { useDialog } from '../lib/useDialog'

interface Props {
  open: boolean
  dir: string
  bookTitle: string
  notify: (text: string, error?: boolean) => void
  onClose: () => void
}

export default function StatsModal({ open, dir, bookTitle, notify, onClose }: Props) {
  const dialogRef = useDialog(open, onClose)
  const [stats, setStats] = useState<WritingStatsSummary | null>(null)
  const [goal, setGoal] = useState('2000')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setStats(null)
    void (async () => {
      try {
        const current = await unwrap(studio.stats.get({ dir }))
        setStats(current)
        setGoal(String(current.goalWords || 2000))
      } catch (err) {
        notify((err as Error).message, true)
      } finally {
        setLoading(false)
      }
    })()
  }, [open, dir, notify])

  const chart = useMemo(() => (stats?.daily ?? []).slice(-14), [stats])
  const maxWords = useMemo(() => Math.max(1, ...chart.map((item) => item.words)), [chart])

  if (!open) return null

  const saveGoal = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const next = await unwrap(studio.stats.setGoal({ dir, goalWords: Number(goal) || 0 }))
      setStats(next)
      notify(next.goalWords > 0 ? `每日目标已设为 ${next.goalWords} 字` : '已关闭每日目标')
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setSaving(false)
    }
  }

  const progress = stats && stats.goalWords > 0 ? Math.min(1, stats.todayWords / stats.goalWords) : 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal stats-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <BarChart3 size={17} style={{ color: 'var(--accent)' }} />
          <div className="modal__title">写作统计 ·《{bookTitle}》</div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="modal__body stats-body">
          {loading || !stats ? (
            <div className="stats-loading">
              <Loader2 size={16} className="spin" />
              读取统计…
            </div>
          ) : (
            <>
              <div className="stats-summary">
                <div className="stats-card">
                  <span className="stats-card__label">今日新增</span>
                  <span className="stats-card__value">{stats.todayWords.toLocaleString('zh-CN')}</span>
                  <span className="stats-card__hint">
                    {stats.goalWords > 0 ? `目标 ${stats.goalWords.toLocaleString('zh-CN')}` : '未设目标'}
                  </span>
                </div>
                <div className="stats-card">
                  <span className="stats-card__label">总字数</span>
                  <span className="stats-card__value">{stats.totalWords.toLocaleString('zh-CN')}</span>
                  <span className="stats-card__hint">仅正文章节</span>
                </div>
                <div className="stats-card">
                  <span className="stats-card__label">
                    <Flame size={13} /> 连续写作
                  </span>
                  <span className="stats-card__value">{stats.streakDays} 天</span>
                  <span className="stats-card__hint">每天至少写 1 字</span>
                </div>
              </div>

              {stats.goalWords > 0 && (
                <div className="stats-progress">
                  <div className="stats-progress__head">
                    <span>今日目标进度</span>
                    <span>{Math.round(progress * 100)}%</span>
                  </div>
                  <div className="stats-progress__bar">
                    <div className="stats-progress__fill" style={{ width: `${progress * 100}%` }} />
                  </div>
                </div>
              )}

              <div className="stats-chart">
                <div className="stats-chart__title">最近 14 天</div>
                <div className="stats-bars">
                  {chart.map((item) => (
                    <div className="stats-bar" key={item.date} title={`${item.date}：${item.words} 字`}>
                      <div
                        className={`stats-bar__fill${item.words === 0 ? ' is-empty' : ''}`}
                        style={{ height: `${Math.max(2, (item.words / maxWords) * 100)}%` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="stats-chart__labels">
                  <span>{chart[0]?.date.slice(5) ?? ''}</span>
                  <span>{chart[chart.length - 1]?.date.slice(5) ?? ''}</span>
                </div>
              </div>

              <div className="stats-goal">
                <Target size={14} />
                <span>每日目标</span>
                <input
                  className="stats-goal__input"
                  type="number"
                  min={0}
                  step={100}
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                />
                <span className="settings-inline-hint">字 / 天（0 = 不设目标）</span>
                <button className="primary" onClick={() => void saveGoal()} disabled={saving}>
                  {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                  保存目标
                </button>
              </div>
              <div className="settings-hint">
                统计按「正文章节字数」计算：草稿、知识文件不计入；归档草稿或导入章节后才会增加。
                删除章节只会更新基线，不会把当天字数扣成负数。
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
