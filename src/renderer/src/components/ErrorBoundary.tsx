import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

/**
 * 渲染进程错误边界：UI 崩溃时给出可操作的兜底页（重载 / 打开日志），
 * 并把错误送到主进程结构化日志，避免白屏无迹可查。
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    void window.studio?.app
      .log({
        level: 'error',
        message: `renderer crash: ${error.message}`,
        data: { stack: error.stack, componentStack: info.componentStack },
      })
      .catch(() => undefined)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <div className="crash__card">
          <div className="crash__title">界面出了点问题</div>
          <div className="crash__hint">
            错误已记录到本地日志，书稿和 Git 历史不受影响。可以先重新加载；如果反复出现，请把日志附到
            GitHub Issue。
          </div>
          <pre className="crash__detail">{this.state.error.message}</pre>
          <div className="crash__actions">
            <button className="primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <button
              onClick={() => {
                void window.studio?.app.openDir({ target: 'logs' }).catch(() => undefined)
              }}
            >
              打开日志目录
            </button>
          </div>
        </div>
      </div>
    )
  }
}
