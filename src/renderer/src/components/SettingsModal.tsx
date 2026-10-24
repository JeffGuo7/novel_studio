import { useEffect, useMemo, useState } from 'react'
import catalog from '@shared/model-catalog.json'
import type { AppSettings, CustomProviderConfig } from '@shared/model-config'
import { studio, unwrap } from '../lib/api'

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
  notify: (text: string, error?: boolean) => void
}

interface CatalogProvider {
  id: string
  models: Array<{ id: string; name: string; api: string; reasoning: boolean; contextWindow: number; input: string[] }>
}

const PROVIDERS = (catalog as { providers: CatalogProvider[] }).providers
const CUSTOM = '__custom__'

export default function SettingsModal({ open, onClose, onSaved, notify }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [provider, setProvider] = useState('deepseek')
  const [model, setModel] = useState('deepseek-flash')
  const [apiKey, setApiKey] = useState('')
  const [budget, setBudget] = useState('0.5')
  const [customId, setCustomId] = useState('my-openai')
  const [customApi, setCustomApi] = useState('openai-completions')
  const [customBaseUrl, setCustomBaseUrl] = useState('https://api.openai.com/v1')
  const [customModel, setCustomModel] = useState('gpt-4o-mini')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)

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
          setModel(selection.model)
        } else {
          setProvider(selection.provider)
          setModel(selection.model)
        }
        setApiKey('')
        setBudget(String(current.budgetUsd ?? 0.5))
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
      <div className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <div className="modal__title">本机配置</div>
          <div className="modal__spacer" />
          <button className="ghost" onClick={onClose}>
            关闭
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

          <div className="settings-hint">
            密钥用系统 safeStorage 加密后存在本机配置里，不进入仓库、不写入书库、不发送给渲染进程以外的进程。
            保存后 Agent 会按新配置重启。
          </div>

          <div className="settings-actions">
            <button className="primary" onClick={() => void save()} disabled={busy}>
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
