/**
 * 从 pi SDK 生成精简的模型目录（provider -> models）。
 * 为什么要预生成：模型目录在 ESM-only 的 pi-ai 里，而 Electron 主进程产物是 CJS，
 * 运行时动态 import 会被打包器转成 require 而失败；预生成 JSON 既稳定又快。
 * 更新模型目录：npm run gen:catalog
 */
import { getModels, getProviders } from '@earendil-works/pi-ai/compat'
import fs from 'node:fs'
import path from 'node:path'

const providers = []
for (const id of getProviders()) {
  let models = []
  try {
    models = getModels(id).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      api: model.api,
      reasoning: Boolean(model.reasoning),
      contextWindow: model.contextWindow || 0,
      input: Array.isArray(model.input) ? model.input : ['text'],
    }))
  } catch {
    models = []
  }
  if (models.length > 0) providers.push({ id, models })
}

providers.sort((a, b) => a.id.localeCompare(b.id))
for (const provider of providers) provider.models.sort((a, b) => a.id.localeCompare(b.id))

const outfile = path.resolve('src/shared/model-catalog.json')
fs.mkdirSync(path.dirname(outfile), { recursive: true })
// 不写时间戳：保证可重复生成，CI 可以用 git diff 校验目录是否与 SDK 同步
fs.writeFileSync(outfile, JSON.stringify({ providers }, null, 2) + '\n', 'utf8')

const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0)
console.log(`catalog: ${providers.length} providers / ${totalModels} models -> ${outfile}`)
