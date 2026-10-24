import type { FileDiff } from '@shared/types'
import { diffStat, renderWordDiff } from '../lib/diff'

interface Props {
  title: string
  subtitle?: string
  files: FileDiff[]
  onClose: () => void
  onRollback?: () => void
}

export default function DiffModal({ title, subtitle, files, onClose, onRollback }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <div className="modal__title">{title}</div>
          {subtitle && <div className="doc-header__sub">{subtitle}</div>}
          <div className="modal__spacer" />
          {onRollback && (
            <button className="danger" onClick={onRollback}>
              回滚到此版本
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal__body">
          {files.length === 0 && <div className="empty">两个版本内容一致</div>}
          {files.map((file) => {
            const stat = diffStat(file.before, file.after)
            return (
              <div className="diff-file" key={file.path}>
                <div className="diff-file__name">
                  {file.path}
                  <span style={{ float: 'right', color: 'var(--muted-2)' }}>
                    +{stat.added} / -{stat.removed}
                  </span>
                </div>
                <div
                  className="diff-file__body"
                  dangerouslySetInnerHTML={{ __html: renderWordDiff(file.before, file.after) }}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
