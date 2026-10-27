import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource/cormorant-garamond/500.css'
import '@fontsource/cormorant-garamond/600.css'
import '@fontsource/cormorant-garamond/700.css'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles.css'

// 未被 React 捕获的错误也写进主进程日志（节流，避免错误风暴刷爆日志）
let lastReport = 0
function report(message: string, data?: unknown): void {
  const now = Date.now()
  if (now - lastReport < 2_000) return
  lastReport = now
  void window.studio?.app.log({ level: 'error', message: `window: ${message}`, data }).catch(() => undefined)
}

window.addEventListener('error', (event) => {
  report(event.message, { stack: event.error?.stack, source: event.filename, line: event.lineno })
})
window.addEventListener('unhandledrejection', (event) => {
  report(`unhandledrejection: ${String(event.reason)}`, {
    stack: event.reason instanceof Error ? event.reason.stack : undefined,
  })
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
