import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStatus } from '@shared/agent'
import { studio, unwrap } from '../lib/api'

interface Props {
  dir: string
  bookTitle: string
  onBookChanged: () => void
  notify: (text: string, error?: boolean) => void
}

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
}

interface ToolTrace {
  id: number
  summary: string
  ok?: boolean
}

const QUICK_PROMPTS = ['续写下一章', '把这一章的开头重写得更抓人', '检查目前设定有没有前后矛盾']

export default function AssistantPanel({ dir, bookTitle, onBookChanged, notify }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [tools, setTools] = useState<ToolTrace[]>([])
  const [status, setStatus] = useState<AgentStatus>('starting')
  const [model, setModel] = useState('')
  const [usage, setUsage] = useState({ input: 0, output: 0, cost: 0 })
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const nextId = () => {
    seq.current += 1
    return seq.current
  }

  const scrollToBottom = useCallback(() => {
    const node = bodyRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [])

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const info = await unwrap(studio.agent.ensure({ dir, title: bookTitle }))
        if (disposed) return
        setModel(info.model)
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
            setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: event.text }])
          }
          break
        case 'tool_start':
          setTools((prev) => [...prev, { id: nextId(), summary: event.summary }])
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
            return next
          })
          break
        case 'turn_end':
          if (event.usage) {
            setUsage((prev) => ({
              input: prev.input + event.usage!.input,
              output: prev.output + event.usage!.output,
              cost: prev.cost + event.usage!.cost,
            }))
          }
          break
        case 'book_changed':
          onBookChanged()
          break
        case 'error':
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
  }, [dir, bookTitle, notify, onBookChanged, scrollToBottom])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streaming, tools, scrollToBottom])

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || busy) return
    setBusy(true)
    setInput('')
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: content }])
    try {
      await unwrap(studio.agent.send({ dir, title: bookTitle, text: content }))
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

  const reset = async () => {
    if (!window.confirm('清空 Agent 的记忆（不影响书稿）？')) return
    await unwrap(studio.agent.reset())
    setMessages([])
    setTools([])
    setStreaming('')
  }

  const statusText =
    status === 'thinking' ? '思考中…' : status === 'tool' ? '调用工具…' : status === 'error' ? '出错' : '就绪'

  return (
    <div className="assistant">
      <div className="assistant__head">
        <span className={`dot dot-${status}`} />
        <span className="assistant__status">{statusText}</span>
        <div className="topbar__spacer" />
        {model && <span className="pill">{model}</span>}
        {(status === 'thinking' || status === 'tool') && (
          <button className="ghost" onClick={() => void stop()}>
            停止
          </button>
        )}
        <button className="ghost" onClick={() => void reset()} title="清空 Agent 记忆">
          重置
        </button>
      </div>

      <div className="assistant__body" ref={bodyRef}>
        {messages.length === 0 && !streaming && (
          <div className="assistant__empty">
            <p>和 Agent 一起写这本书。它可以读世界观、大纲、上一章，把新章节写成草稿——正史永远要你点头。</p>
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
              <div key={tool.id} className={`tool-trace ${tool.ok === false ? 'is-error' : ''}`}>
                <span className="tool-trace__icon">{tool.ok === undefined ? '…' : tool.ok ? '✓' : '×'}</span>
                <span>{tool.summary}</span>
              </div>
            ))}
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`bubble bubble-${message.role}`}>
            {message.text}
          </div>
        ))}
        {streaming && <div className="bubble bubble-assistant bubble-streaming">{streaming}</div>}
      </div>

      <div className="assistant__composer">
        <textarea
          rows={3}
          placeholder="告诉 Agent 你想让它做什么…（Enter 发送，Shift+Enter 换行）"
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
            {usage.input + usage.output > 0
              ? `${usage.input} in / ${usage.output} out · $${usage.cost.toFixed(4)}`
              : ' '}
          </span>
          <div className="topbar__spacer" />
          <button className="primary" disabled={!input.trim()} onClick={() => void send(input)}>
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
