import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  BookOpen,
  Bot,
  FileInput,
  FilePlus,
  FileText,
  History,
  PenLine,
  Save,
  Settings,
  Wand2,
  X,
} from 'lucide-react'
import type { BookSnapshot, CommitInfo, DraftInfo, FileDiff } from '@shared/types'
import { formatTime, formatWords, studio, unwrap } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import AssistantPanel from './AssistantPanel'
import DiffModal from './DiffModal'

type Selection =
  | { kind: 'chapter'; chapterKey: string; path: string | null; title: string }
  | { kind: 'knowledge'; path: string; title: string }

interface Props {
  dir: string
  onBack: () => void
  notify: (text: string, error?: boolean) => void
  onOpenSettings: () => void
  settingsVersion: number
}

/** 从草稿正文第一行推一个默认归档标题，例如 "# 第 1 章 雾夜渡客" → "雾夜渡客" */
function guessDraftTitle(chapterKey: string, content: string): string {
  const firstLine = content.split('\n').find((line) => line.trim().startsWith('#'))?.trim() ?? ''
  const cleaned = firstLine
    .replace(/^#+\s*/, '')
    .replace(new RegExp(`^第\\s*${Number(chapterKey)}\\s*章\\s*`), '')
    .trim()
  return cleaned || `第 ${Number(chapterKey)} 章`
}

export default function Workbench({ dir, onBack, notify, onOpenSettings, settingsVersion }: Props) {
  const [snapshot, setSnapshot] = useState<BookSnapshot | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [mode, setMode] = useState<'read' | 'edit'>('read')
  const [drafts, setDrafts] = useState<DraftInfo[]>([])
  const [activeDraftVersion, setActiveDraftVersion] = useState<number | null>(null)
  const [history, setHistory] = useState<CommitInfo[]>([])
  const [tab, setTab] = useState<'history' | 'drafts' | 'assistant'>('drafts')
  const [diffModal, setDiffModal] = useState<{ title: string; subtitle?: string; files: FileDiff[]; rollbackOid?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [promoteTitle, setPromoteTitle] = useState('')
  const [pipeline, setPipeline] = useState<{
    running: boolean
    phase?: string
    current?: number
    total?: number
    message?: string
    error?: string
  } | null>(null)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)

  const dirty = content !== savedContent
  const isChapter = selection?.kind === 'chapter'
  const hasDrafts = drafts.length > 0
  const latestDraft = drafts[0] ?? null
  const chapterKey = isChapter ? selection.chapterKey : null

  const refreshSnapshot = useCallback(async (): Promise<BookSnapshot> => {
    const next = await unwrap(studio.openBook(dir))
    setSnapshot(next)
    return next
  }, [dir])

  const refreshHistory = useCallback(async () => {
    const commits = await unwrap(studio.history({ dir, depth: 100 }))
    setHistory(commits)
  }, [dir])

  /** Agent 写了草稿后：刷新书库；如果当前没在草稿上，自动跳到 Agent 新写的章节 */
  const handleAgentBookChanged = useCallback(async () => {
    const book = await refreshSnapshot()
    if (selection?.kind === 'chapter') {
      try {
        const list = await unwrap(studio.listDrafts({ dir, chapterKey: selection.chapterKey }))
        setDrafts(list)
      } catch {
        // 章节可能刚被归档/删除，忽略
      }
    } else if (book.orphanDraftKeys.length > 0) {
      const key = book.orphanDraftKeys[0]
      const list = await unwrap(studio.listDrafts({ dir, chapterKey: key })).catch(() => [])
      const next: Selection = {
        kind: 'chapter',
        chapterKey: key,
        path: null,
        title: `第 ${Number(key)} 章`,
      }
      setSelection(next)
      setDrafts(list)
      if (list.length > 0) {
        const latest = await unwrap(studio.readDraft({ dir, chapterKey: key, version: list[0].version }))
        setContent(latest.content)
        setSavedContent(latest.content)
        setPromoteTitle(guessDraftTitle(key, latest.content))
        setMode('read')
        notify(`Agent 写了第 ${Number(key)} 章草稿 v${latest.info.version}，正史未改动`)
      }
    }
    await refreshHistory()
  }, [dir, selection, refreshSnapshot, refreshHistory])

  const loadFileContent = useCallback(async (sel: Selection) => {
    if (sel.kind === 'knowledge') {
      const file = await unwrap(studio.readFile({ dir, path: sel.path }))
      setContent(file.content)
      setSavedContent(file.content)
      setDrafts([])
      setActiveDraftVersion(null)
      return
    }
    const list = await unwrap(studio.listDrafts({ dir, chapterKey: sel.chapterKey }))
    setDrafts(list)
    setActiveDraftVersion(null)
    if (list.length > 0) {
      const latest = await unwrap(studio.readDraft({ dir, chapterKey: sel.chapterKey, version: list[0].version }))
      setContent(latest.content)
      setSavedContent(latest.content)
      setPromoteTitle(guessDraftTitle(sel.chapterKey, latest.content))
      return
    }
    if (sel.path) {
      const file = await unwrap(studio.readFile({ dir, path: sel.path }))
      setContent(file.content)
      setSavedContent(file.content)
    } else {
      setContent('')
      setSavedContent('')
    }
  }, [dir])

  // 打开书
  useEffect(() => {
    void (async () => {
      try {
        const book = await refreshSnapshot()
        await refreshHistory()
        const first: Selection =
          book.chapters.length > 0
            ? { kind: 'chapter', chapterKey: book.chapters[0].key, path: book.chapters[0].path, title: book.chapters[0].title }
            : { kind: 'knowledge', path: 'world_model.md', title: '世界模型' }
        setSelection(first)
        await loadFileContent(first)
        setMode('read')
      } catch (err) {
        notify((err as Error).message, true)
      }
    })()
  }, [dir, refreshSnapshot, refreshHistory, loadFileContent, notify])

  const select = useCallback(
    async (sel: Selection) => {
      if (dirty) {
        const leave = window.confirm('当前有未保存的修改，确定切换吗？')
        if (!leave) return
      }
      setSelection(sel)
      setMode('read')
      // 正在和 Agent 对话时切换章节，不要把「助手」标签顶掉
      setTab((prev) => (prev === 'assistant' ? 'assistant' : sel.kind === 'chapter' ? 'drafts' : 'history'))
      await loadFileContent(sel)
    },
    [dirty, loadFileContent],
  )

  const selectChapterByKey = useCallback(
    async (key: string) => {
      const chapter = snapshot?.chapters.find((item) => item.key === key)
      const selectionNext: Selection = {
        kind: 'chapter',
        chapterKey: key,
        path: chapter?.path ?? null,
        title: chapter?.title ?? `第 ${Number(key)} 章`,
      }
      await select(selectionNext)
    },
    [snapshot, select],
  )

  const save = useCallback(async () => {
    if (!selection || busy) return
    setBusy(true)
    try {
      if (selection.kind === 'knowledge') {
        const result = await unwrap(studio.saveFile({ dir, path: selection.path, content }))
        setSnapshot(result.snapshot)
        setSavedContent(content)
        notify(result.oid ? '已保存并提交' : '内容无变化')
      } else if (hasDrafts) {
        const info = await unwrap(studio.saveDraft({ dir, chapterKey: selection.chapterKey, content, source: 'human' }))
        setSavedContent(content)
        setActiveDraftVersion(null)
        const list = await unwrap(studio.listDrafts({ dir, chapterKey: selection.chapterKey }))
        setDrafts(list)
        setSnapshot(await refreshSnapshot())
        notify(`已保存草稿 v${info.version}`)
      } else if (selection.path) {
        const result = await unwrap(studio.saveFile({ dir, path: selection.path, content }))
        setSnapshot(result.snapshot)
        setSavedContent(content)
        notify(result.oid ? '已保存并提交' : '内容无变化')
      }
      await refreshHistory()
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }, [selection, busy, content, dir, hasDrafts, notify, refreshHistory, refreshSnapshot])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const startDraft = useCallback(async () => {
    if (!selection || selection.kind !== 'chapter' || busy) return
    setBusy(true)
    try {
      await unwrap(studio.seedDraft({ dir, chapterKey: selection.chapterKey }))
      const list = await unwrap(studio.listDrafts({ dir, chapterKey: selection.chapterKey }))
      setDrafts(list)
      setSnapshot(await refreshSnapshot())
      setActiveDraftVersion(null)
      if (list.length > 0) {
        const latest = await unwrap(studio.readDraft({ dir, chapterKey: selection.chapterKey, version: list[0].version }))
        setContent(latest.content)
        setSavedContent(latest.content)
      }
      setMode('edit')
      setTab('drafts')
      notify('已创建草稿 v1')
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }, [selection, busy, dir, notify, refreshSnapshot])

  const createChapter = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const created = await unwrap(studio.createChapter({ dir }))
      const book = await refreshSnapshot()
      await refreshHistory()
      const chapter = book.chapters.find((item) => item.key === created.chapterKey)
      const next: Selection = {
        kind: 'chapter',
        chapterKey: created.chapterKey,
        path: chapter?.path ?? null,
        title: chapter?.title ?? `第 ${Number(created.chapterKey)} 章`,
      }
      setSelection(next)
      await loadFileContent(next)
      setMode('edit')
      setTab('drafts')
      setPromoteTitle(`第 ${Number(created.chapterKey)} 章`)
      notify(`已新建第 ${Number(created.chapterKey)} 章草稿`)
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }, [busy, dir, loadFileContent, notify, refreshHistory, refreshSnapshot])

  const importBook = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await unwrap(studio.importFile({ dir }))
      if (result.canceled || !result.snapshot) return
      setSnapshot(result.snapshot)
      await refreshHistory()
      const report = result.report
      if (report) {
        notify(`已导入 ${report.chapters} 章 · ${report.words} 字（${report.encoding}）`)
        const first = result.snapshot.chapters[0]
        if (first) {
          const next: Selection = {
            kind: 'chapter',
            chapterKey: first.key,
            path: first.path,
            title: first.title,
          }
          setSelection(next)
          await loadFileContent(next)
          setMode('read')
        }
      }
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }, [busy, dir, loadFileContent, notify, refreshHistory])

  // 知识库初始化：监听管线事件
  useEffect(() => {
    const off = studio.pipeline.onEvent((event) => {
      if (event.type === 'started') {
        setPipeline({ running: true, phase: 'chunk', current: 0, total: 0, message: `共 ${event.chapters} 章` })
        return
      }
      if (event.type === 'progress') {
        setPipeline({
          running: true,
          phase: event.progress.phase,
          current: event.progress.current,
          total: event.progress.total,
          message: event.progress.message,
        })
        return
      }
      if (event.type === 'done') {
        setPipeline({ running: false, phase: 'done', message: `完成 ${event.report.chapters} 章` })
        notify(
          `知识库已初始化：${event.report.files.length} 个文件，花费 $${event.report.cost.toFixed(4)}`,
        )
        void refreshSnapshot()
        void refreshHistory()
        return
      }
      if (event.type === 'error') {
        setPipeline((prev) => ({
          ...(prev ?? { running: false }),
          running: false,
          error: event.message,
        }))
        notify(event.message, true)
      }
    })
    return off
  }, [notify, refreshHistory, refreshSnapshot])

  const startKnowledge = useCallback(async () => {
    if (!snapshot || snapshot.chapters.length === 0) {
      notify('先导入或新建章节，再初始化知识库', true)
      return
    }
    if (pipeline?.running) return
    const words = snapshot.chapters.reduce((sum, chapter) => sum + chapter.words, 0)
    const chunks = Math.max(1, Math.ceil(words / 12000))
    const ok = window.confirm(
      `用当前模型整理 ${snapshot.chapters.length} 章（约 ${words} 字）？\n\n会分约 ${chunks} 块调用模型，生成：剧情总纲 / 世界模型 / 状态卡 / 逐章大纲。\n会产生少量模型费用（可在「本机配置」查看模型）。`,
    )
    if (!ok) return
    setPipeline({ running: true, phase: 'chunk', current: 0, total: chunks, message: '启动中…' })
    try {
      await unwrap(studio.pipeline.start({ dir, title: snapshot.meta.title }))
    } catch (err) {
      setPipeline(null)
      notify((err as Error).message, true)
    }
  }, [snapshot, pipeline, dir, notify])

  const cancelKnowledge = useCallback(async () => {
    try {
      await unwrap(studio.pipeline.cancel())
    } catch (err) {
      notify((err as Error).message, true)
    }
  }, [notify])

  const promote = useCallback(async () => {
    if (!selection || selection.kind !== 'chapter' || !hasDrafts || busy) return
    const title = promoteTitle.trim() || selection.title
    setBusy(true)
    try {
      const book = await unwrap(studio.promoteDraft({ dir, chapterKey: selection.chapterKey, title }))
      setSnapshot(book)
      await refreshHistory()
      const chapter = book.chapters.find((item) => item.key === selection.chapterKey)
      const next: Selection = {
        kind: 'chapter',
        chapterKey: selection.chapterKey,
        path: chapter?.path ?? null,
        title: chapter?.title ?? title,
      }
      setSelection(next)
      setDrafts([])
      setActiveDraftVersion(null)
      if (chapter) {
        const file = await unwrap(studio.readFile({ dir, path: chapter.path }))
        setContent(file.content)
        setSavedContent(file.content)
      }
      setMode('read')
      notify(`已归档第 ${Number(selection.chapterKey)} 章`)
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }, [selection, hasDrafts, busy, promoteTitle, dir, notify, refreshHistory, refreshSnapshot])

  const discard = useCallback(async () => {
    if (!selection || selection.kind !== 'chapter' || !hasDrafts) return
    if (!window.confirm(`确定丢弃第 ${Number(selection.chapterKey)} 章的全部草稿？正史不受影响。`)) return
    try {
      const result = await unwrap(studio.discardDrafts({ dir, chapterKey: selection.chapterKey }))
      setSnapshot(result.snapshot)
      setDrafts([])
      setActiveDraftVersion(null)
      await loadFileContent(selection)
      setMode('read')
      notify('草稿已丢弃')
    } catch (err) {
      notify((err as Error).message, true)
    }
  }, [selection, hasDrafts, dir, loadFileContent, notify])

  const viewDraft = useCallback(
    async (version: number) => {
      if (!selection || selection.kind !== 'chapter') return
      try {
        const draft = await unwrap(studio.readDraft({ dir, chapterKey: selection.chapterKey, version }))
        setContent(draft.content)
        setSavedContent(draft.content)
        setActiveDraftVersion(version)
        setMode('read')
        setPromoteTitle(selection.title)
      } catch (err) {
        notify((err as Error).message, true)
      }
    },
    [selection, dir, notify],
  )

  const restoreDraft = useCallback(async () => {
    if (!selection || selection.kind !== 'chapter' || activeDraftVersion === null) return
    setActiveDraftVersion(null)
    setMode('edit')
    notify('已载入该版本，保存即生成新草稿')
  }, [selection, activeDraftVersion, notify])

  const showCommitDiff = useCallback(
    async (commit: CommitInfo) => {
      try {
        const parent = commit.parents[0]
        const files = parent
          ? await unwrap(studio.diff({ dir, from: parent, to: commit.oid }))
          : await unwrap(studio.diff({ dir, from: commit.oid, to: commit.oid }))
        setDiffModal({
          title: commit.summary || commit.message.split('\n')[0],
          subtitle: `${formatTime(commit.timestamp)} · ${commit.short}`,
          files,
          rollbackOid: commit.oid,
        })
      } catch (err) {
        notify((err as Error).message, true)
      }
    },
    [dir, notify],
  )

  const showDraftDiff = useCallback(async () => {
    if (!selection || selection.kind !== 'chapter' || activeDraftVersion === null || !latestDraft) return
    if (activeDraftVersion === latestDraft.version) {
      notify('已经是最新版本')
      return
    }
    try {
      const [older, latest] = await Promise.all([
        unwrap(studio.readDraft({ dir, chapterKey: selection.chapterKey, version: activeDraftVersion })),
        unwrap(studio.readDraft({ dir, chapterKey: selection.chapterKey, version: latestDraft.version })),
      ])
      setDiffModal({
        title: `草稿 v${activeDraftVersion} → v${latestDraft.version}`,
        subtitle: selection.title,
        files: [{ path: `drafts/${selection.chapterKey}`, before: older.content, after: latest.content }],
      })
    } catch (err) {
      notify((err as Error).message, true)
    }
  }, [selection, activeDraftVersion, latestDraft, dir, notify])

  const rollback = useCallback(
    async (oid: string) => {
      if (!window.confirm('回滚会还原书库到该版本，并生成一个新的「还原」提交（历史不会丢失）。继续？')) return
      setBusy(true)
      try {
        const result = await unwrap(studio.rollback({ dir, oid }))
        const book = await refreshSnapshot()
        await refreshHistory()
        setDiffModal(null)
        const sel = selection
        if (sel) await loadFileContent(sel)
        notify(`已回滚到 ${oid.slice(0, 7)}（改动 ${result.changedFiles} 个文件）`)
        if (book.chapters.length === 0) setSelection(null)
      } catch (err) {
        notify((err as Error).message, true)
      } finally {
        setBusy(false)
      }
    },
    [dir, selection, loadFileContent, notify, refreshHistory, refreshSnapshot],
  )

  const pipelinePercent = pipeline?.total ? Math.round(((pipeline.current ?? 0) / pipeline.total) * 100) : 0
  const pipelinePhaseText =
    pipeline?.phase === 'merge'
      ? '生成知识文件'
      : pipeline?.phase === 'write'
        ? '写入并提交'
        : pipeline?.phase === 'done'
          ? '完成'
          : '整理章节'

  const html = useMemo(() => renderMarkdown(content), [content])
  const words = useMemo(() => content.replace(/\s+/g, '').length, [content])
  const titleText = selection?.title ?? ''

  return (
    <div className="workbench">
      <div className="topbar">
        <button className="ghost" onClick={onBack}>
          <ArrowLeft size={15} />
          书架
        </button>
        <div className="topbar__title">{snapshot?.meta.title ?? '载入中…'}</div>
        <span className="pill">{snapshot?.chapters.length ?? 0} 章</span>
        {snapshot?.head && <span className="pill">HEAD {snapshot.head.slice(0, 7)}</span>}
        <div className="topbar__spacer" />
        <span className="topbar__status">
          {dirty ? '有未保存修改' : hasDrafts ? `草稿 v${drafts[0]?.version}` : '已同步'}
        </span>
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
          <Save size={15} />
          保存
          {dirty && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'currentColor',
                display: 'inline-block',
              }}
            />
          )}
        </button>
        <button onClick={() => void createChapter()} disabled={busy}>
          <FilePlus size={15} />
          新建章节
        </button>
        <button onClick={() => void importBook()} disabled={busy} title="导入 txt / md 文本">
          <FileInput size={15} />
          导入
        </button>
        <button
          onClick={() => void startKnowledge()}
          disabled={busy || pipeline?.running || (snapshot?.chapters.length ?? 0) === 0}
          title="用模型整理章节，生成剧情总纲 / 世界模型 / 状态卡 / 逐章大纲"
        >
          <Wand2 size={15} />
          初始化知识
        </button>
        <button className="ghost" onClick={onOpenSettings} title="模型与密钥配置">
          <Settings size={15} />
          配置
        </button>
      </div>

      <div className="workspace">
        <div className="sidebar">
          <div className="sidebar__section">
            <div className="sidebar__label">章节</div>
            {snapshot?.chapters.length === 0 && <div className="panel-hint">还没有章节，点右上角「新建章节」。</div>}
            {snapshot?.chapters.map((chapter) => (
              <button
                key={chapter.key}
                className={`tree-item ${selection?.kind === 'chapter' && selection.chapterKey === chapter.key ? 'active' : ''}`}
                onClick={() => void select({ kind: 'chapter', chapterKey: chapter.key, path: chapter.path, title: chapter.title })}
              >
                <BookOpen size={14} />
                <span className="num">{chapter.key}</span>
                <span className="name">{chapter.title}</span>
                {chapter.hasDraft && <span className="badge">草稿</span>}
                <span className="words">{chapter.words}</span>
              </button>
            ))}
            {snapshot?.orphanDraftKeys.map((key) => (
              <button
                key={`orphan-${key}`}
                className={`tree-item ${selection?.kind === 'chapter' && selection.chapterKey === key ? 'active' : ''}`}
                onClick={() => void selectChapterByKey(key)}
              >
                <FileText size={14} />
                <span className="num">{key}</span>
                <span className="name">未成章</span>
                <span className="badge">草稿</span>
              </button>
            ))}
          </div>

          <div className="sidebar__section">
            <div className="sidebar__label">知识文件</div>
            {snapshot?.knowledge.map((file) => (
              <button
                key={file.name}
                className={`tree-item ${selection?.kind === 'knowledge' && selection.path === file.name ? 'active' : ''}`}
                onClick={() => void select({ kind: 'knowledge', path: file.name, title: file.title })}
              >
                <FileText size={14} />
                <span className="name">{file.title}</span>
                <span className="words">{file.words}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="workspace__center">
          <div className="doc-header">
            <div className="doc-header__title">{titleText}</div>
            <div className="doc-header__sub">
              {formatWords(words)}
              {activeDraftVersion !== null && ` · 查看草稿 v${activeDraftVersion}`}
              {isChapter && hasDrafts && activeDraftVersion === null && ` · 草稿 v${latestDraft?.version}`}
              {isChapter && !hasDrafts && ' · 正史'}
            </div>
            <div className="doc-header__spacer" />
            {mode === 'read' ? (
              <button onClick={() => setMode('edit')}>编辑</button>
            ) : (
              <button onClick={() => setMode('read')}>阅读</button>
            )}
            {isChapter && (
              <>
                {!hasDrafts && mode === 'read' && (
                  <button className="primary" onClick={() => void startDraft()}>
                    开始草稿
                  </button>
                )}
                {hasDrafts && (
                  <>
                    <button onClick={() => void save()} disabled={!dirty || busy}>
                      保存草稿版本
                    </button>
                    <button className="primary" onClick={() => void promote()} disabled={busy}>
                      归档为第 {Number(chapterKey)} 章
                    </button>
                  </>
                )}
              </>
            )}
          </div>

          {mode === 'edit' ? (
            <textarea
              ref={editorRef}
              className="editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
            />
          ) : (
            <div className="doc-body reading" dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>

        <div className={`rightbar ${tab === 'assistant' ? 'rightbar-wide' : ''}`}>
          <div className="tabs">
            <button className={`tab ${tab === 'drafts' ? 'active' : ''}`} onClick={() => setTab('drafts')}>
              <PenLine size={14} />
              草稿
            </button>
            <button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
              <History size={14} />
              历史
            </button>
            <button className={`tab ${tab === 'assistant' ? 'active' : ''}`} onClick={() => setTab('assistant')}>
              <Bot size={14} />
              助手
            </button>
          </div>

          {tab === 'assistant' ? (
            <AssistantPanel
              key={settingsVersion}
              dir={dir}
              bookTitle={snapshot?.meta.title ?? '未命名'}
              chapterKey={selection?.kind === 'chapter' ? selection.chapterKey : undefined}
              onBookChanged={() => void handleAgentBookChanged()}
              notify={notify}
            />
          ) : tab === 'drafts' ? (
            <>
              {!isChapter ? (
                <div className="tab-body">
                  <div className="panel-hint">草稿按章节管理。选择一个章节，或新建章节。</div>
                </div>
              ) : (
                <>
                  <div className="draft-toolbar">
                    {!hasDrafts ? (
                      <button className="primary" onClick={() => void startDraft()} disabled={busy}>
                        新建草稿
                      </button>
                    ) : (
                      <>
                        <button onClick={() => void save()} disabled={!dirty || busy}>
                          保存新版本
                        </button>
                        <button onClick={() => void showDraftDiff()} disabled={activeDraftVersion === null}>
                          对比最新版
                        </button>
                        <button className="danger" onClick={() => void discard()} disabled={busy}>
                          丢弃草稿
                        </button>
                      </>
                    )}
                  </div>
                  <div className="tab-body">
                    {!hasDrafts && <div className="panel-hint">这个章节还没有草稿。草稿不会进 Git 历史，随便改。</div>}
                    {hasDrafts && (
                      <>
                        <input
                          style={{ width: '100%', marginBottom: 10 }}
                          placeholder="归档时的章节标题"
                          value={promoteTitle}
                          onChange={(event) => setPromoteTitle(event.target.value)}
                        />
                        {drafts.map((draft) => (
                          <button
                            key={draft.version}
                            className={`entry ${activeDraftVersion === draft.version ? 'active' : ''}`}
                            onClick={() => void viewDraft(draft.version)}
                          >
                            <div className="entry__top">
                              <span className="entry__kind">v{draft.version}</span>
                              <span className="entry__summary">
                                {draft.source === 'ai' ? 'AI 生成' : draft.source === 'seed' ? '初始草稿' : '人工编辑'}
                                {draft.note ? ` · ${draft.note}` : ''}
                              </span>
                            </div>
                            <div className="entry__time">
                              {formatTime(new Date(draft.createdAt).getTime())} · {formatWords(draft.words)}
                            </div>
                          </button>
                        ))}
                        {activeDraftVersion !== null && activeDraftVersion !== latestDraft?.version && (
                          <button className="primary" style={{ width: '100%', marginTop: 8 }} onClick={() => void restoreDraft()}>
                            以 v{activeDraftVersion} 为基础继续编辑
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="tab-body">
              {history.length === 0 && <div className="panel-hint">还没有提交历史。</div>}
              {history.map((commit) => (
                <button key={commit.oid} className="entry" onClick={() => void showCommitDiff(commit)}>
                  <div className="entry__top">
                    <span className={`entry__kind kind-${commit.kind}`}>{commit.kind}</span>
                    <span className="entry__summary">{commit.summary}</span>
                  </div>
                  <div className="entry__time">
                    {formatTime(commit.timestamp)} · {commit.short}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {diffModal && (
        <DiffModal
          title={diffModal.title}
          subtitle={diffModal.subtitle}
          files={diffModal.files}
          onClose={() => setDiffModal(null)}
          onRollback={diffModal.rollbackOid ? () => void rollback(diffModal.rollbackOid!) : undefined}
        />
      )}

      {pipeline && (pipeline.running || pipeline.error) && (
        <div className="modal-backdrop">
          <div className="modal pipeline-modal">
            <div className="modal__header">
              <Wand2 size={17} style={{ color: 'var(--accent)' }} />
              <div className="modal__title">初始化知识库</div>
              <div className="modal__spacer" />
              <button
                className="ghost icon-btn"
                aria-label="关闭"
                disabled={pipeline.running}
                onClick={() => setPipeline(null)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal__body pipeline-body">
              {pipeline.error ? (
                <div className="pipeline-error">{pipeline.error}</div>
              ) : (
                <>
                  <div className="pipeline-phase">
                    {pipelinePhaseText}
                    <span className="pipeline-counter">
                      {pipeline.current ?? 0}/{pipeline.total ?? 0}
                    </span>
                  </div>
                  <div className="pipeline-track">
                    <div className="pipeline-track__fill" style={{ width: `${pipelinePercent}%` }} />
                  </div>
                  <div className="pipeline-message">{pipeline.message ?? '正在处理…'}</div>
                  <div className="pipeline-hint">
                    会依次生成：剧情总纲 → 世界模型 → 状态卡 → 逐章大纲，并作为一个「[知识] 初始化」提交。
                  </div>
                </>
              )}
            </div>
            <div className="pipeline-actions">
              {pipeline.running ? (
                <button className="danger" onClick={() => void cancelKnowledge()}>
                  取消
                </button>
              ) : (
                <button className="primary" onClick={() => setPipeline(null)}>
                  完成
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
