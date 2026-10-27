import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, Minimize2, RotateCcw, Send, Square, X } from 'lucide-react'
import type { AgentStatus, ChatToolTrace } from '@shared/agent'
import { studio, unwrap } from '../lib/api'

interface Props {
  dir: string
  bookTitle: string
  /** 当前选中的章节（用于单章成本统计与预算） */
  chapterKey?: string
  onBookChanged: () => void
  notify: (text: string, error?: boolean) => void
  onOpenSettings?: () => void
}

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  tools?: ChatToolTrace[]
}

/** 实时轨迹：在共享 ChatToolTrace 之上加一个稳定的 React key */
type ToolTrace = ChatToolTrace & { key: number }

const QUICK_PROMPTS = ['续写下一章', '把这一章的开头重写得更抓人', '检查目前设定有没有前后矛盾']

const formatBudget = (value: number) => (value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2))

export default function AssistantPanel({
  dir,
  bookTitle,
  chapterKey,
  onBookChanged,
  notify,
  onOpenSettings,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [tools, setTools] = useState<ToolTrace[]>([])
  const [status, setStatus] = useState<AgentStatus>('starting')
  const [model, setModel] = useState('')
  const [usage, setUsage] = useState({ input: 0, output: 0 })
  const [sessionCost, setSessionCost] = useState(0)
  const [budgetUsd, setBudgetUsd] = useState(0)
  const [chapterCost, setChapterCost] = useState(0)
  const [chapterBudgetUsd, setChapterBudgetUsd] = useState(0)
  const [blockedSession, setBlockedSession] = useState(false)
  const [blockedChapter, setBlockedChapter] = useState<string | null>(null)
  const [warnRatio, setWarnRatio] = useState(0.8)
  const [contextWindow, setContextWindow] = useState(0)
  const [lastInputTokens, setLastInputTokens] = useState(0)
  const [compacting, setCompacting] = useState(false)
  const [compactionNote, setCompactionNote] = useState('')
  const [restoredNote, setRestoredNote] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const toolsRef = useRef<ToolTrace[]>([])
  const warnedSession = useRef(false)
  const warnedChapter = useRef<string | null>(null)

  const nextId = () => {
    seq.current += 1
    return seq.current
  }

  const scrollToBottom = useCallback(() => {
    const node = bodyRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [])

  const currentChapterBlocked = Boolean(blockedChapter && chapterKey === blockedChapter)
  const blocked = blockedSession || currentChapterBlocked

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const info = await unwrap(studio.agent.ensure({ dir, title: bookTitle }))
        if (disposed) return
        const settings = await unwrap(studio.settings.get())
        setWarnRatio(settings.budgetWarnRatio ?? 0.8)
        setModel(info.model)
        setSessionCost(info.sessionCost ?? 0)
        setBudgetUsd(info.budgetUsd ?? 0)
        setChapterBudgetUsd(info.chapterBudgetUsd ?? 0)
        setContextWindow(info.contextWindow ?? 0)
        if (info.compaction) {
          setCompactionNote(
            `已压缩 ${info.compaction.coveredMessages} 条早期对话（摘要 ${info.compaction.summaryChars} 字，原文仍保留）`,
          )
        }
        const costs = info.chapterCosts ?? {}
        if (chapterKey) {
          const used = costs[chapterKey] ?? 0
          setChapterCost(used)
          if ((info.chapterBudgetUsd ?? 0) > 0 && used >= (info.chapterBudgetUsd ?? 0)) {
            setBlockedChapter(chapterKey)
          }
        }
        if ((info.budgetUsd ?? 0) > 0 && (info.sessionCost ?? 0) >= (info.budgetUsd ?? 0)) {
          setBlockedSession(true)
        }

        // 历史会话：把上次的对话渲染出来（不只是提示"已恢复"）
        const history = await unwrap(studio.agent.loadSession({ dir }))
        if (disposed) return
        if (history.length > 0) {
          seq.current = history.length
          setMessages(
            history.map((item, index) => ({
              id: index + 1,
              role: item.role,
              text: item.text,
              tools: item.tools,
            })),
          )
        } else if ((info.restoredMessages ?? 0) > 0) {
          setRestoredNote(
            `已恢复上次对话（${info.restoredMessages} 条消息，累计花费 $${(info.sessionCost ?? 0).toFixed(4)}）`,
          )
        }
      } catch (err) {
        notify((err as Error).message, true)
        setStatus('error')
      }
    })()

    const off = studio.agent.onEvent((event) => {
      switch (event.type) {
        case 'status':
          setStatus(event.status)
          break
        case 'assistant_delta':
          setStreaming((prev) => prev + event.delta)
          break
        case 'assistant_done':
          setStreaming('')
          if (event.text.trim()) {
            const traces = toolsRef.current.length > 0 ? [...toolsRef.current] : undefined
            toolsRef.current = []
            setTools([])
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: 'assistant', text: event.text, tools: traces },
            ])
          }
          break
        case 'tool_start':
          setTools((prev) => {
            const key = nextId()
            const next: ToolTrace[] = [
              ...prev,
              { key, id: `${event.tool}-${key}`, name: event.tool, summary: event.summary },
            ]
            toolsRef.current = next
            return next
          })
          break
        case 'tool_end':
          setTools((prev) => {
            const next = [...prev]
            for (let index = next.length - 1; index >= 0; index -= 1) {
              if (next[index].ok === undefined) {
                next[index] = { ...next[index], ok: event.ok }
                break
              }
            }
            toolsRef.current = next
            return next
          })
          break
        case 'turn_end':
          if (event.usage) {
            setUsage((prev) => ({
              input: prev.input + event.usage!.input,
              output: prev.output + event.usage!.output,
            }))
            setLastInputTokens(event.usage.input)
          }
          if (typeof event.sessionCost === 'number') setSessionCost(event.sessionCost)
          if (typeof event.budgetUsd === 'number') setBudgetUsd(event.budgetUsd)
          if (event.chapterKey && typeof event.chapterCost === 'number') {
            setChapterCost(event.chapterCost)
          }
          if (typeof event.chapterBudgetUsd === 'number') setChapterBudgetUsd(event.chapterBudgetUsd)

          // 80% 预警：每次会话/每章只在首次越过阈值时提示一次
          if (
            typeof event.sessionCost === 'number' &&
            typeof event.budgetUsd === 'number' &&
            event.budgetUsd > 0 &&
            event.sessionCost < event.budgetUsd &&
            event.sessionCost / event.budgetUsd >= warnRatio &&
            !warnedSession.current
          ) {
            warnedSession.current = true
            notify(
              `会话预算已用 ${Math.round((event.sessionCost / event.budgetUsd) * 100)}%：$${event.sessionCost.toFixed(4)} / $${formatBudget(event.budgetUsd)}，接近上限`,
            )
          }
          if (
            event.chapterKey &&
            typeof event.chapterCost === 'number' &&
            typeof event.chapterBudgetUsd === 'number' &&
            event.chapterBudgetUsd > 0 &&
            event.chapterCost < event.chapterBudgetUsd &&
            event.chapterCost / event.chapterBudgetUsd >= warnRatio &&
            warnedChapter.current !== event.chapterKey
          ) {
            warnedChapter.current = event.chapterKey
            notify(
              `第 ${Number(event.chapterKey)} 章预算已用 ${Math.round((event.chapterCost / event.chapterBudgetUsd) * 100)}%，接近上限`,
            )
          }
          break
        case 'budget_exceeded':
          if (event.scope === 'session') {
            setBlockedSession(true)
            notify(
              `本次会话预算已用尽（$${event.cost.toFixed(4)} / $${event.budgetUsd.toFixed(2)}），已停止`,
              true,
            )
          } else {
            setBlockedChapter(event.chapterKey ?? null)
            notify(
              `第 ${Number(event.chapterKey)} 章预算已用尽（$${event.cost.toFixed(4)} / $${event.budgetUsd.toFixed(2)}）`,
              true,
            )
          }
          break
        case 'compaction_started':
          setCompacting(true)
          break
        case 'compaction_done':
          setCompacting(false)
          setLastInputTokens(0)
          setCompactionNote(
            `已压缩 ${event.coveredMessages} 条早期对话（约 ${Math.round(event.tokensBefore / 1000)}k → ${Math.round(event.tokensAfter / 1000)}k tokens，摘要 ${event.summaryChars} 字）`,
          )
          notify(
            `对话已压缩：约 ${Math.round(event.tokensBefore / 1000)}k → ${Math.round(event.tokensAfter / 1000)}k tokens`,
          )
          break
        case 'session_restored':
          setSessionCost(event.cost)
          setLastInputTokens(0)
          setUsage({ input: 0, output: 0 })
          setChapterCost(0)
          setBlockedSession(false)
          setBlockedChapter(null)
          warnedSession.current = false
          warnedChapter.current = null
          if (event.messages === 0) setRestoredNote('')
          break
        case 'book_changed':
          onBookChanged()
          break
        case 'error':
          setCompacting(false)
          notify(event.message, true)
          break
        default:
          break
      }
      scrollToBottom()
    })

    return () => {
      disposed = true
      off()
    }
  }, [dir, bookTitle, chapterKey, notify, onBookChanged, scrollToBottom, warnRatio])

  // 切换章节时同步该章已花费，并按单章预算判断是否封锁
  useEffect(() => {
    warnedChapter.current = null
    if (!chapterKey) {
      setChapterCost(0)
      return
    }
    void (async () => {
      try {
        const info = await unwrap(studio.agent.info())
        if (!info) return
        const used = info.chapterCosts?.[chapterKey] ?? 0
        const limit = info.chapterBudgetUsd ?? 0
        setChapterCost(used)
        if (limit > 0) setChapterBudgetUsd(limit)
        if (limit > 0 && used >= limit) setBlockedChapter(chapterKey)
        else setBlockedChapter((prev) => (prev === chapterKey ? null : prev))
      } catch {
        // Host 还没起来时忽略，下一轮事件会刷新
      }
    })()
  }, [chapterKey])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streaming, tools, scrollToBottom])

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || busy) return
    if (blockedSession) {
      notify('本次会话预算已用尽：先在「本机配置」调高预算，或点「重置」开始新会话', true)
      return
    }
    if (currentChapterBlocked) {
      notify(`第 ${Number(chapterKey)} 章预算已用尽，可切换章节或重置会话`, true)
      return
    }
    setBusy(true)
    setInput('')
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: content }])
    try {
      await unwrap(studio.agent.send({ dir, title: bookTitle, text: content, chapterKey }))
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    try {
      await unwrap(studio.agent.abort())
    } catch (err) {
      notify((err as Error).message, true)
    }
  }

  const compact = async () => {
    if (compacting) return
    setCompacting(true)
    try {
      await unwrap(studio.agent.compact())
    } catch (err) {
      setCompacting(false)
      notify((err as Error).message, true)
    }
  }

  const reset = async () => {
    if (!window.confirm('清空 Agent 的记忆与本次会话花费（不影响书稿）？')) return
    await unwrap(studio.agent.reset())
    setMessages([])
    setTools([])
    setStreaming('')
    setUsage({ input: 0, output: 0 })
    setLastInputTokens(0)
    setCompactionNote('')
    setRestoredNote('')
    setChapterCost(0)
    setBlockedChapter(null)
    warnedSession.current = false
    warnedChapter.current = null
  }

  const statusText =
    status === 'thinking' ? '思考中…' : status === 'tool' ? '调用工具…' : status === 'error' ? '出错' : '就绪'
  const sessionCostText =
    budgetUsd > 0
      ? `$${sessionCost.toFixed(4)} / $${formatBudget(budgetUsd)}`
      : `$${sessionCost.toFixed(4)}`
  const chapterCostText =
    chapterKey && chapterBudgetUsd > 0
      ? ` · 本章 $${chapterCost.toFixed(4)} / $${formatBudget(chapterBudgetUsd)}`
      : ''
  const sessionRatio = budgetUsd > 0 ? sessionCost / budgetUsd : 0
  const chapterRatio = chapterKey && chapterBudgetUsd > 0 ? chapterCost / chapterBudgetUsd : 0
  const budgetNearLimit = !blocked && (sessionRatio >= warnRatio || chapterRatio >= warnRatio)

  return (
    <div className="assistant">
      <div className="assistant__head">
        <span className={`dot dot-${status}`} />
        <span className="assistant__status">{statusText}</span>
        <div className="topbar__spacer" />
        {chapterKey && <span className="pill">第 {Number(chapterKey)} 章</span>}
        {model && <span className="pill">{model}</span>}
        {(status === 'thinking' || status === 'tool') && (
          <button className="ghost" onClick={() => void stop()}>
            <Square size={12} />
            停止
          </button>
        )}
        <button
          className="ghost"
          onClick={() => void compact()}
          disabled={compacting || status === 'thinking' || status === 'tool'}
          title="把较早的对话压成摘要（原文仍保留在本地）"
        >
          {compacting ? <Loader2 size={13} className="spin" /> : <Minimize2 size={13} />}
          {compacting ? '压缩中…' : '压缩'}
        </button>
        <button className="ghost" onClick={() => void reset()} title="清空 Agent 记忆与会话花费">
          <RotateCcw size={13} />
          重置
        </button>
      </div>

      <div className="assistant__body" ref={bodyRef}>
        {restoredNote && <div className="assistant__note">{restoredNote}</div>}
        {compactionNote && <div className="assistant__note">{compactionNote}</div>}

        {messages.length === 0 && !streaming && !restoredNote && (
          <div className="assistant__empty">
            <p>
              和 Agent 一起写这本书。它可以读世界观、大纲、上一章，把新章节写成草稿——正史永远要你点头。
            </p>
            <div className="assistant__chips">
              {QUICK_PROMPTS.map((prompt) => (
                <button key={prompt} className="chip" onClick={() => void send(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {tools.length > 0 && (
          <div className="assistant__tools">
            {tools.map((tool) => (
              <div key={tool.key} className={`tool-trace ${tool.ok === false ? 'is-error' : ''}`}>
                <span className={`tool-trace__icon ${tool.ok === undefined ? 'is-running' : ''}`}>
                  {tool.ok === undefined ? <Loader2 size={12} /> : tool.ok ? <Check size={12} /> : <X size={12} />}
                </span>
                <span>{tool.summary}</span>
              </div>
            ))}
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className="assistant__msg">
            {message.tools && message.tools.length > 0 && (
              <div className="assistant__tools">
                {message.tools.map((tool) => (
                  <div key={tool.id} className={`tool-trace ${tool.ok === false ? 'is-error' : ''}`}>
                    <span className="tool-trace__icon">
                      {tool.ok === false ? <X size={12} /> : <Check size={12} />}
                    </span>
                    <span>{tool.summary}</span>
                  </div>
                ))}
              </div>
            )}
            <div className={`bubble bubble-${message.role}`}>{message.text}</div>
          </div>
        ))}
        {streaming && <div className="bubble bubble-assistant bubble-streaming">{streaming}</div>}
      </div>

      <div className="assistant__composer">
        {budgetNearLimit && (
          <div className="assistant__budgetwarn">
            <AlertTriangle size={13} />
            <span>
              {sessionRatio >= warnRatio &&
                `会话预算已用 ${Math.round(sessionRatio * 100)}%（$${sessionCost.toFixed(4)} / $${formatBudget(budgetUsd)}）`}
              {sessionRatio >= warnRatio && chapterRatio >= warnRatio && ' · '}
              {chapterRatio >= warnRatio &&
                `本章预算已用 ${Math.round(chapterRatio * 100)}%（$${chapterCost.toFixed(4)} / $${formatBudget(chapterBudgetUsd)}）`}
            </span>
            {onOpenSettings && (
              <button className="ghost" onClick={onOpenSettings}>
                调高预算
              </button>
            )}
          </div>
        )}
        {blocked && (
          <div className="assistant__blocked">
            {blockedSession
              ? '本次会话预算已用尽。在「本机配置」调高预算，或点「重置」开始新会话。'
              : `第 ${Number(chapterKey)} 章预算已用尽。切换章节继续，或点「重置」开始新会话。`}
          </div>
        )}
        <textarea
          rows={3}
          disabled={blocked}
          placeholder={
            blocked ? '预算已用尽，无法继续发送' : '告诉 Agent 你想让它做什么…（Enter 发送，Shift+Enter 换行）'
          }
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send(input)
            }
          }}
        />
        <div className="assistant__composer-foot">
          <span className="usage">
            {usage.input + usage.output > 0 ? `${usage.input} in / ${usage.output} out · ` : ''}
            {lastInputTokens > 0 && contextWindow > 0
              ? `上下文 ${(lastInputTokens / 1000).toFixed(1)}k / ${Math.round(contextWindow / 1000)}k · `
              : ''}
            {sessionCostText}
            {chapterCostText}
          </span>
          <div className="topbar__spacer" />
          <button className="primary" disabled={!input.trim() || blocked} onClick={() => void send(input)}>
            <Send size={14} />
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
