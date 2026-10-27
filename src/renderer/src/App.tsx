import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import type { BookSnapshot } from '@shared/types'
import { studio, unwrap } from './lib/api'
import Bookshelf from './components/Bookshelf'
import SettingsModal from './components/SettingsModal'
import Workbench from './components/Workbench'

export default function App() {
  const [bookDir, setBookDir] = useState<string | null>(null)
  const [books, setBooks] = useState<BookSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsVersion, setSettingsVersion] = useState(0)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const toastTimer = useRef<number | null>(null)

  const notify = useCallback((text: string, error?: boolean) => {
    setToast({ text, error })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  const refreshBooks = useCallback(async () => {
    const list = await unwrap(studio.listBooks())
    setBooks(list)
  }, [])

  useEffect(() => {
    const unsubscribe = studio.update.onEvent((event) => {
      if (event.type === 'available' && event.result.hasUpdate) {
        notify(`发现新版本 v${event.result.latestVersion}，可在「配置 → 更新」里下载`)
      }
    })
    return unsubscribe
  }, [notify])

  useEffect(() => {
    void refreshBooks()
      .catch((err: Error) => notify(err.message, true))
      .finally(() => setLoading(false))
  }, [refreshBooks, notify])

  const backToShelf = useCallback(() => {
    setBookDir(null)
    void refreshBooks().catch((err: Error) => notify(err.message, true))
  }, [refreshBooks, notify])

  return (
    <>
      {bookDir ? (
        <Workbench
          dir={bookDir}
          onBack={backToShelf}
          notify={notify}
          onOpenSettings={() => setSettingsOpen(true)}
          settingsVersion={settingsVersion}
        />
      ) : (
        <Bookshelf
          books={books}
          loading={loading}
          onRefresh={refreshBooks}
          onOpen={setBookDir}
          onOpenSettings={() => setSettingsOpen(true)}
          notify={notify}
        />
      )}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => setSettingsVersion((value) => value + 1)}
        onLibraryChanged={() => void refreshBooks()}
        notify={notify}
      />
      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'} aria-live={toast.error ? 'assertive' : 'polite'}>
          {toast.error ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
          <span>{toast.text}</span>
        </div>
      )}
    </>
  )
}
