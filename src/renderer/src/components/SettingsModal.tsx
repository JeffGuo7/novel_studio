import { useEffect, useMemo, useState } from 'react'
import { Archive, CheckCircle2, Download, Loader2, RefreshCw, Save, ShieldCheck, Upload, X } from 'lucide-react'
import catalog from '@shared/model-catalog.json'
import type { AppSettings, CustomProviderConfig } from '@shared/model-config'
import type { AppInfo, AppUpdateInfo } from '@shared/types'
import { studio, unwrap } from '../lib/api'
import { useDialog } from '../lib/useDialog'

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
  onLibraryChanged?: () => void
  notify: (text: string, error?: boolean) => void
}

interface CatalogProvider {
  id: string
  models: Array<{ id: string; name: string; api: string; reasoning: boolean; contextWindow: number; input: string[] }>
}

const PROVIDERS = (catalog as { providers: CatalogProvider[] }).providers
const CUSTOM = '__custom__'

export default function SettingsModal({ open, onClose, onSaved, onLibraryChanged, notify }: Props) {
  const dialogRef = useDialog(open, onClose)

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [provider, setProvider] = useState('deepseek')
  const [model, setModel] = useState('deepseek-flash')
  const [apiKey, setApiKey] = useState('')
  const [budget, setBudget] = useState('0.5')
  const [chapterBudget, setChapterBudget] = useState('0.2')
  const [warnPercent, setWarnPercent] = useState('80')
  const [customId, setCustomId] = useState('my-openai')
  const [customApi, setCustomApi] = useState('openai-completions')
  const [customBaseUrl, setCustomBaseUrl] = useState('https://api.openai.com/v1')
  const [customModel, setCustomModel] = useState('gpt-4o-mini')
  const [customContextWindow, setCustomContextWindow] = useState('128000')
  const [customMaxTokens, setCustomMaxTokens] = useState('8192')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null)
  const [downloaded, setDownloaded] = useState(false)
  const [dataBusy, setDataBusy] = useState(false)

  const isCustom = provider === CUSTOM
  const providerModels = useMemo(() => PROVIDERS.find((item) => item.id === provider)?.models ?? [], [provider])
  const filteredModels = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const list = keyword ? providerModels.filter((item) => item.id.toLowerCase().includes(keyword)) : providerModels
    return list.slice(0, 300)
  }, [providerModels, search])

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const current = await unwrap(studio.settings.get())
        setSettings(current)
        const selection = current.selection
        if (selection.providerConfig) {
          setProvider(CUSTOM)
          setCustomId(selection.providerConfig.id)
          setCustomApi(selection.providerConfig.api || 'openai-completions')
          setCustomBaseUrl(selection.providerConfig.baseUrl || '')
          setCustomModel(selection.model)
          setCustomContextWindow(String(selection.providerConfig.contextWindow ?? 128000))
          setCustomMaxTokens(String(selection.providerConfig.maxTokens ?? 8192))
          setModel(selection.model)
        } else {
          setProvider(selection.provider)
          setModel(selection.model)
        }
        setApiKey('')
        setBudget(String(current.budgetUsd ?? 0.5))
        setChapterBudget(String(current.chapterBudgetUsd ?? 0.2))
        setWarnPercent(String(Math.round((current.budgetWarnRatio ?? 0.8) * 100)))
        setInfo(await unwrap(studio.app.info()))
      } catch (err) {
        notify((err as Error).message, true)
      }
    })()
  }, [open, notify])

  useEffect(() => {
    if (isCustom || providerModels.length === 0) return
    if (!providerModels.some((item) => item.id === model)) {
      setModel(providerModels[0].id)
    }
  }, [providerModels, model, isCustom])

  // 更新事件：进度 / 下载完成 / 错误（自动检查与手动检查共用）
  useEffect(() => {
    if (!open) return
    const unsubscribe = studio.update.onEvent((event) => {
      if (event.type === 'progress') {
        setProgress({ received: event.received, total: event.total })
        return
      }
      if (event.type === 'downloaded') {
        setDownloading(false)
        setDownloaded(true)
        notify(event.verified ? '更新包已下载并校验通过' : '更新包已下载（未校验）')
        return
      }
      if (event.type === 'error') {
        setDownloading(false)
        notify(event.message, true)
        return
      }
      if (event.type === 'available') {
        setUpdate(event.result)
      }
    })
    return unsubscribe
  }, [open, notify, downloaded])

  // 打开配置时静默检查一次更新（已是最新 / 开发模式不打扰）
  useEffect(() => {
    if (!open) return
    setUpdate(null)
    setDownloaded(false)
    setProgress(null)
    void (async () => {
      try {
        const result = await unwrap(studio.update.check())
        setUpdate(result)
      } catch {
        // 更新检查失败不打扰用户
      }
    })()
  }, [open])

  const openDir = async (target: 'workspace' | 'userData' | 'logs') => {
    try {
      await unwrap(studio.app.openDir({ target }))
    } catch (err) {
      notify((err as Error).message, true)
    }
  }

  const checkUpdate = async () => {
    setChecking(true)
    try {
      const result = await unwrap(studio.update.check())
      setUpdate(result)
      if (result.error) notify(result.error, true)
      else if (result.dev) notify('开发模式不检查更新（打包后的版本才可用）')
      else if (result.hasUpdate) notify(`发现新版本 v${result.latestVersion}`)
      else notify('已是最新版本')
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setChecking(false)
    }
  }

  const downloadUpdate = async () => {
    setDownloading(true)
    setProgress(null)
    try {
      await unwrap(studio.update.download())
    } catch (err) {
      notify((err as Error).message, true)
      setDownloading(false)
    }
  }

  const installUpdate = async () => {
    try {
      await unwrap(studio.update.install())
    } catch (err) {
      notify((err as Error).message, true)
    }
  }

  const openReleases = async () => {
    try {
      await unwrap(studio.update.openPage())
    } catch (err) {
      notify((err as Error).message, true)
    }
  }

  const exportBackup = async () => {
    setDataBusy(true)
    try {
      const result = await unwrap(studio.backup.export({}))
      if (result.canceled) return
      if (result.report) {
        notify(
          `已备份 ${result.report.books} 本书（${Math.round(result.report.bytes / 1024 / 1024)} MB）到 ${result.report.file}`,
        )
      }
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setDataBusy(false)
    }
  }

  const restoreBackup = async () => {
    if (!window.confirm('从备份恢复会把备份里的书导入当前书库；同名的书会跳过，不会覆盖现有数据。继续？')) return
    setDataBusy(true)
    try {
      const result = await unwrap(studio.backup.restore({}))
      if (result.canceled || !result.report) return
      const { restored, skipped, errors } = result.report
      notify(`已恢复 ${restored.length} 本，跳过 ${skipped.length} 本${errors.length ? `，${errors.length} 本有问题` : ''}`)
      onLibraryChanged?.()
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setDataBusy(false)
    }
  }

  const checkLibrary = async () => {
    setDataBusy(true)
    try {
      const health = await unwrap(studio.backup.health())
      if (health.broken.length === 0) notify(`书库健康：${health.books} 本书全部可读`)
      else notify(`书库 ${health.books} 本正常，${health.broken.length} 本损坏：${health.broken[0].dir}`, true)
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setDataBusy(false)
    }
  }

  if (!open) return null

  const save = async () => {
    setBusy(true)
    try {
      const customProviders: CustomProviderConfig[] = [...(settings?.customProviders ?? [])]
      let selection
      if (isCustom) {
        const config: CustomProviderConfig = {
          id: customId.trim(),
          api: customApi.trim() || 'openai-completions',
          baseUrl: customBaseUrl.trim(),
          ...(Number(customContextWindow) > 0 ? { contextWindow: Number(customContextWindow) } : {}),
          ...(Number(customMaxTokens) > 0 ? { maxTokens: Number(customMaxTokens) } : {}),
        }
        const index = customProviders.findIndex((item) => item.id === config.id)
        if (index >= 0) customProviders[index] = config
        else customProviders.push(config)
        selection = { provider: config.id, model: customModel.trim(), providerConfig: config }
      } else {
        selection = { provider, model }
      }
      const next = await unwrap(
        studio.settings.save({
          selection,
          customProviders,
          budgetUsd: Number(budget) || 0,
          chapterBudgetUsd: Number(chapterBudget) || 0,
          budgetWarnRatio: Math.min(0.95, Math.max(0.5, (Number(warnPercent) || 80) / 100)),
          ...(apiKey.trim() ? { apiKey: apiKey.trim(), apiKeyProvider: selection.provider } : {}),
        }),
      )
      setSettings(next)
      notify(`已保存：${selection.provider} / ${selection.model}`)
      onSaved()
      onClose()
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    if (!settings) return
    setBusy(true)
    try {
      const next = await unwrap(
        studio.settings.save({
          selection: settings.selection,
          customProviders: settings.customProviders,
          apiKey: '',
          apiKeyProvider: settings.selection.provider,
        }),
      )
      setSettings(next)
      notify('已清除该 provider 的本地密钥')
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal settings-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <div className="modal__title">本机配置</div>
          <div className="modal__spacer" />
          <button className="ghost icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="modal__body settings-body">
          <div className="settings-row">
            <label>模型供应商</label>
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              {PROVIDERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}（{item.models.length} 个模型）
                </option>
              ))}
              <option value={CUSTOM}>自定义（OpenAI 兼容）</option>
            </select>
          </div>

          {isCustom ? (
            <>
              <div className="settings-row">
                <label>供应商 ID</label>
                <input value={customId} onChange={(event) => setCustomId(event.target.value)} placeholder="my-openai" />
              </div>
              <div className="settings-row">
                <label>API 类型</label>
                <select value={customApi} onChange={(event) => setCustomApi(event.target.value)}>
                  <option value="openai-completions">openai-completions</option>
                  <option value="openai-responses">openai-responses</option>
                  <option value="anthropic-messages">anthropic-messages</option>
                  <option value="google-generative-ai">google-generative-ai</option>
                </select>
              </div>
              <div className="settings-row">
                <label>Base URL</label>
                <input
                  value={customBaseUrl}
                  onChange={(event) => setCustomBaseUrl(event.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div className="settings-row">
                <label>模型 ID</label>
                <input value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="gpt-4o-mini" />
              </div>
              <div className="settings-row">
                <label>上下文窗口</label>
                <div className="settings-key">
                  <input
                    type="number"
                    min={2048}
                    step={1024}
                    value={customContextWindow}
                    onChange={(event) => setCustomContextWindow(event.target.value)}
                  />
                  <span className="settings-inline-hint">tokens · 模型真实窗口，用于推导上下文预算</span>
                </div>
              </div>
              <div className="settings-row">
                <label>输出上限</label>
                <div className="settings-key">
                  <input
                    type="number"
                    min={512}
                    step={512}
                    value={customMaxTokens}
                    onChange={(event) => setCustomMaxTokens(event.target.value)}
                  />
                  <span className="settings-inline-hint">tokens · 单次回复上限（从窗口里预留）</span>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="settings-row">
                <label>模型</label>
                <div className="settings-model">
                  <input
                    placeholder="搜索模型…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  <select value={model} onChange={(event) => setModel(event.target.value)}>
                    {filteredModels.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                        {item.reasoning ? ' · reasoning' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}

          <div className="settings-row">
            <label>API Key</label>
            <div className="settings-key">
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={settings?.hasApiKey ? '已保存（留空保持不变）' : '粘贴密钥，加密存储在本机'}
              />
              {settings?.hasApiKey && (
                <button className="danger" onClick={() => void clearKey()} disabled={busy}>
                  清除
                </button>
              )}
            </div>
          </div>

          <div className="settings-row">
            <label>会话预算</label>
            <div className="settings-key">
              <input
                type="number"
                min={0}
                step={0.1}
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
              <span className="settings-inline-hint">美元 / 每本书会话，0 = 不限制</span>
            </div>
          </div>

          <div className="settings-row">
            <label>单章预算</label>
            <div className="settings-key">
              <input
                type="number"
                min={0}
                step={0.05}
                value={chapterBudget}
                onChange={(event) => setChapterBudget(event.target.value)}
              />
              <span className="settings-inline-hint">美元 / 同一章连续协作，0 = 不限制</span>
            </div>
          </div>

          <div className="settings-row">
            <label>预警阈值</label>
            <div className="settings-key">
              <input
                type="number"
                min={50}
                max={95}
                step={5}
                value={warnPercent}
                onChange={(event) => setWarnPercent(event.target.value)}
              />
              <span className="settings-inline-hint">% · 会话/单章花费达到该比例时提示</span>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section__title">
              <RefreshCw size={14} />
              更新
            </div>
            <div className="settings-row">
              <label>当前版本</label>
              <div className="settings-key settings-key--wrap">
                <span className="settings-version">v{info?.version ?? '—'}</span>
                <button className="ghost" onClick={() => void checkUpdate()} disabled={checking || downloading}>
                  {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                  检查更新
                </button>
                <button className="ghost" onClick={() => void openReleases()}>
                  打开发布页
                </button>
              </div>
            </div>
            {update && !update.dev && (
              <div className="settings-row">
                <label>状态</label>
                <div className="settings-key settings-key--wrap">
                  {update.error ? (
                    <span className="settings-error">{update.error}</span>
                  ) : update.hasUpdate ? (
                    <>
                      <span>
                        发现新版本 v{update.latestVersion}
                        {update.publishedAt
                          ? `（${new Date(update.publishedAt).toLocaleDateString('zh-CN')}）`
                          : ''}
                      </span>
                      {downloaded ? (
                        <button onClick={() => void installUpdate()}>
                          <CheckCircle2 size={14} />
                          重启并安装
                        </button>
                      ) : (
                        <button onClick={() => void downloadUpdate()} disabled={downloading}>
                          {downloading ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                          {downloading
                            ? progress
                              ? `下载中 ${Math.round((progress.received / Math.max(progress.total, 1)) * 100)}%`
                              : '下载中…'
                            : '下载更新'}
                        </button>
                      )}
                    </>
                  ) : (
                    <span>已是最新版本</span>
                  )}
                </div>
              </div>
            )}
            {update?.dev && (
              <div className="settings-hint settings-hint--tight">
                开发模式不检查更新；打包后的安装版会从 GitHub Releases 检查新版本（下载后校验 SHA256，安装前由你确认）。
              </div>
            )}
          </div>

          <div className="settings-section">
            <div className="settings-section__title">
              <ShieldCheck size={14} />
              数据安全
            </div>
            <div className="settings-row">
              <label>书库备份</label>
              <div className="settings-key settings-key--wrap">
                <button onClick={() => void exportBackup()} disabled={dataBusy}>
                  <Archive size={14} />
                  备份书库
                </button>
                <button onClick={() => void restoreBackup()} disabled={dataBusy}>
                  <Upload size={14} />
                  从备份恢复
                </button>
                <button className="ghost" onClick={() => void checkLibrary()} disabled={dataBusy}>
                  {dataBusy ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
                  检查书库
                </button>
              </div>
            </div>
            <div className="settings-hint settings-hint--tight">
              备份是本地 zip（含每本书的 .git 历史），不上传任何服务器；恢复时同名书会跳过，不覆盖现有数据。
            </div>
          </div>

          <div className="settings-hint">
            密钥用系统 safeStorage 加密后存在本机配置里，不进入仓库、不写入书库、不发送给渲染进程以外的进程。
            保存后 Agent 会按新配置重启。
          </div>

          {provider.startsWith('opencode') && (
            <div className="settings-hint">
              OpenCode 的推理接口要求每次对话带 `x-opencode-session` 与自定义 UA，应用会自动附加。
              Go / Go Plus 套餐请选 <code>opencode-go</code>，普通充值余额选 <code>opencode</code>；
              Key 填在对应 provider 下。
            </div>
          )}

          <div className="settings-about">
            <div className="settings-about__main">
              <div className="settings-about__version">Novel Studio v{info?.version ?? '—'}</div>
              <div className="settings-about__meta">
                Electron {info?.electron ?? '—'} · Node {info?.node ?? '—'} · {info?.platform ?? ''}
              </div>
              <div className="settings-about__path" title={info?.workspace}>
                书库：{info?.workspace ?? '—'}
              </div>
              <div className="settings-about__path" title={info?.userData}>
                配置：{info?.userData ?? '—'}
              </div>
            </div>
            <div className="settings-about__actions">
              <button onClick={() => void openDir('workspace')}>打开书库目录</button>
              <button onClick={() => void openDir('userData')}>打开配置目录</button>
              <button onClick={() => void openDir('logs')}>打开日志目录</button>
            </div>
          </div>

          <div className="settings-actions">
            <button className="primary" onClick={() => void save()} disabled={busy}>
              <Save size={15} />
              保存
            </button>
            <button onClick={onClose} disabled={busy}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
