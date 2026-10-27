# Agent 层设计（pi 基座）

> 这一层回答一个问题：**模型怎么安全、可长期地参与创作。**
> 结论：Agent 只能"读"和"写草稿"，正史归档永远是人类动作；会话可恢复，花费有上限。

## 1. 进程边界

```text
renderer（React）
  └─ IPC 事件/命令
main（Electron）
  ├─ AgentManager：每个书目录一个 utilityProcess，切书即重建
  └─ 密钥：从 settings.json 解密后，只通过子进程 env 传递，不进渲染层
utilityProcess（Agent Host，out/agent/host.mjs）
  ├─ pi-agent-core 的 Agent 循环（模型调用 / 流式 / 工具 / 中断）
  ├─ 会话持久化与成本熔断
  ├─ tools：直接调用 core 领域层（同一台机器、同一份磁盘）
  └─ 事件：status / assistant_delta / tool_start / tool_end / book_changed
```

为什么不用主进程：模型调用 + 工具执行是一段长循环，放在主进程会拖慢窗口/IPC；
`utilityProcess` 崩溃也不会带走整个应用。实测 Electron 45 的 utilityProcess 能直接跑
ESM 版的 pi（bundled 后约 5.6MB），Node 24.22。

## 2. 工具清单（权限边界）

| 工具 | 权限 | 说明 |
|---|---|---|
| `read_context` | 读 | 组装上下文包：世界模型 / 状态卡 / 剧情总纲 / 逐章大纲 / 文风 / 目标章草稿 / 上一章正文 |
| `list_chapters` | 读 | 章节列表 + 下一章 key |
| `read_chapter` | 读 | 按 key 读正文 |
| `search_story` | 读 | 全书剧情检索（本地全文索引，返回片段 + 章节定位） |
| `read_knowledge` | 读 | 读白名单知识文件 |
| `propose_knowledge` | **写建议** | 只能写 `.studio/proposals/`，作者在 UI 里接受后才落盘为正史 |
| `list_drafts` | 读 | 草稿版本列表 |
| `book_history` | 读 | 正史提交历史 |
| `write_draft` | **写草稿** | 唯一正文写入口，落到 `.studio/drafts/<key>/vNNN.md` |

**没有"归档"和"删除"工具**——这是刻意的。归档/删除只能由作者点按钮触发
（`promoteDraft` / `deleteChapter` / `trashBook`），
Agent 即使被提示词注入也没有能力把草稿变成正史，也无法删掉任何东西。
知识文件同理：Agent 只能提建议，"接受"这个动作永远由作者点击完成。

## 3. 事件协议

Host → Main（`process.parentPort`）：

```text
{ type: 'ready', info }        // info 含 model/provider/sessionCost/budgetUsd/restoredMessages
{ type: 'event', event: AgentEvent }
{ type: 'fatal', message }
```

Main → Renderer（`agent:event`）：`status / assistant_delta / assistant_done /
tool_start / tool_end / turn_end(usage, sessionCost, budgetUsd) / budget_exceeded /
session_restored / book_changed / error`

`book_changed` 让 UI 在 Agent 写完草稿后自动刷新书架与草稿列表，
并提示"Agent 写了第 N 章草稿 vX，正史未改动"。

## 4. 模型与密钥

### 4.1 模型目录来自 pi，不是手写清单

- 用 `@earendil-works/pi-ai/compat` 的 `getProviders()/getModels()` 生成模型目录：
  `src/shared/model-catalog.json`（41 个 provider / 1599 个模型，`npm run gen:catalog` 可重新生成）。
- 为什么预生成：目录在 ESM-only 的 pi-ai 里，而 Electron 主进程产物是 CJS，运行时动态
  import 会被打包器转成 require 而失败；预生成 JSON 既稳定又快，UI 也能直接搜索。
- 内置目录里没有的模型，只要给了 `api + baseUrl`，就按「自定义 provider」拼一个同构的
  model 对象（与 s-loop 的做法一致，见 `src/agent/model-registry.ts`）。

### 4.2 配置与密钥

- 配置入口：右上角「本机配置」→ 选 provider / 搜模型 / 填 key；也支持自定义 OpenAI 兼容 endpoint。
- 存哪：`userData/settings.json`，密钥用 Electron `safeStorage` 加密（Windows 走 DPAPI）；
  渲染进程只拿到 `hasApiKey` 布尔值，永远拿不到明文。
- 传递：main 拼出 `NOVEL_STUDIO_RUNTIME_CONFIG`（JSON）通过子进程 env 交给 Host，
  Agent 用 `getApiKey: () => apiKey` 动态取；日志不打印 key。
- 兼容：`.env.local` 里的 `<PROVIDER>_API_KEY` 作为兜底（方便本机开发/CI）。
- 保存配置后会销毁并重建 Agent Host，下一次对话按新配置走。

### 4.3 成本

每轮 usage 从 pi 的 `message.usage` 读取，UI 显示 `in / out / $cost`；
实测 deepseek-flash 一句话问答约 $0.0005，写一章约 $0.002。

### 4.4 OpenCode Zen / Go

OpenCode 的推理接口除了 Bearer token，还要求：

- `x-opencode-session`：同一对话稳定的 session id（缺了会 400 `MissingSessionID`）；
- 自定义 `User-Agent`（OpenCode 明确要求客户端标识自己）。

pi 的 **compat** 入口（我们用 `streamSimple`）不走它自己的 opencode provider 包装器，因此会漏头。
应用侧的做法（`src/agent/opencode.ts`）：

- `isOpenCodeModel()`：按 provider（`opencode` / `opencode-go`）或 baseUrl（`opencode.ai`）识别；
- `withOpenCodeHeaders()`：包一层 stream，注入 session 头与 `NovelStudio/<版本>` UA；
- session id 首次生成后写进会话文件（`opencodeSessionId`），重启保持稳定；
- 知识库管线（`completeSimple`）同样注入，否则「初始化知识」也会失败。

| Provider | 用在哪 | Key 环境变量兜底 |
|---|---|---|
| `opencode` | Console 余额/按量付费 | `OPENCODE_API_KEY` |
| `opencode-go` | Go / Go Plus 套餐 | `OPENCODE_GO_API_KEY` |

> 注意：Go 套餐的响应里 `cost` 为 0、实际消耗记在 `opencode.allowance`；
> pi 归一化 usage 时按模型标价估算，所以 UI 里的 `$cost` 是**标价估算**，不是套餐扣费。
> 预算熔断仍按这个估算值兜底。


### 4.5 上下文预算（模型驱动）

**上下限来自模型自身，不写死字符数。**

- pi 已经负责输出侧：`streamSimple` 内部通过 `clampMaxTokensToContext()` 按 `model.contextWindow`
  夹 `maxTokens`，并预留 4096 safety tokens；
- 输入侧没有自动裁剪——pi 的官方扩展点是 Agent 的 `transformContext(messages)` 钩子，我们在
  `src/agent/context-budget.ts` 里实现：
  - `contextWindow` / `maxTokens` 取自模型目录（自定义模型可在配置里手填）；
  - `inputBudget = contextWindow - maxOutput - safety`（safety = max(6144, 窗口 2%)）；
  - `packBudget = 输入预算 × 32%`（上限 24k tokens，防止一次工具结果吃掉整本书）；
  - `historyBudget = 输入预算 × 45%`；
- token 估算：以 pi 的 `estimateTextTokens()` 为基准，再取「中文保守估算（1.6 字/token）」的较大者，
  避免中文被低估导致真实溢出；
- 裁剪规则：保留 system、裁剪起点对齐 user、`toolCall`/`toolResult` 成对保留；单条超长工具结果先截断；
- 上下文包各小节（世界/状态/总纲/大纲/文风/本章草稿/上一章）按权重分配字符上限，模型越大给得越多；
- 助手面板显示「上下文 0.8k / 1000k」，`contextWindow` 来自模型元数据。

> pi 没有内置的"对话摘要压缩器"：它提供的是 `transformContext` 钩子和 `isContextOverflow()`
> 检测工具。对话压缩（/compact）已实现在这个钩子上，见 6.5。

### 4.6 剧情检索（search_story）

- 本地全文索引：MiniSearch + 中文 1/2-gram，**不需要 embedding 模型**（详见 `docs/story-index.md`）；
- 索引存 `<书>/.studio/index/`，检索前按 `size/mtime → hash` 惰性增量同步，修改一章约 4ms；
- 工具 `search_story(query, limit)` 返回命中片段 + 章节定位 + 相关度，默认 5 条（最多 8）；
- 系统提示要求：回忆旧情节先检索，命中后用 `read_chapter` 读原文，避免凭印象编造；
- 选型与基准（hit@1 9/9，1000 章索引 18MB）见 `docs/story-index.md`。

### 4.7 AI 知识建议与大纲向导

- **建议目录**：`.studio/proposals/<id>.json`（不进 Git）。Agent 调用 `propose_knowledge` 只能写这里；
- **审批 UI**：顶栏「AI 建议」→ 左侧列表、右侧词级 diff；「接受并提交」写入知识文件并提交
  `[知识] 采纳 AI 建议：<标题>`，「拒绝」直接删除建议；
- **大纲向导**：一句话创意 → 用当前模型生成主线 / 分卷 / 世界模型三条建议（同样走审批）；
  生成进程复用知识库管线的 utilityProcess，可取消，不直接改文件；
- **红线**：AI 不能把建议变正史；接受动作只来自作者点击。

### 4.8 实体卡与卷摘要

- 四份新知识文件：`characters.md`（人物卡）、`locations.md`（地点卡）、`factions.md`（势力卡）、
  `volume_summary.md`（卷摘要）；
- 由知识库管线在文风步骤之后**一次调用**生成（基于逐章大纲 + 剧情总纲 + 旧卡合并），
  失败软跳过并在进度里提示，不影响其余文件；
- 上下文包按模型预算分配额度注入这四份文件（默认约 200–1800 字/份，随 `contextWindow` 放大）；
- 目标：让 Agent 写新章时既知道"世界规则"，也知道"人现在在哪、和谁什么关系、这一卷到哪了"。

## 5. 中断与干预

- `abort()`：停止当前生成；
- `steer()`：生成过程中插话，Agent 在下一个 turn 边界改道；
- `reset()`：清空 Agent 记忆与会话花费（不动书稿）。

## 6. 会话持久化与成本熔断

### 6.1 会话持久化

- 位置：`<bookDir>/.studio/agent/session.json`（`.studio` 已被书库 `.gitignore` 忽略）。
- 内容：pi 的 `AgentMessage[]` + 累计成本 + 更新时间；Host 启动时恢复，
  每轮结束后与 `agent_end` / `abort` 时原子落盘。
- 裁剪：只保留最近 120 条，且**起点必须落在 `user` 消息上**，避免把
  `assistant(toolCall)` 与 `toolResult` 拆散导致模型拒收。
- 截断：单条消息里的超长字符串（整章正文、工具结果）超过 4000 字符会被截断并留标记，
  避免会话文件无限膨胀。
- 「重置」会同时清空记忆与会话文件，重新开始计费。

### 6.2 成本熔断（会话级 + 单章级）

- 设置项：
  - `AppSettings.budgetUsd`：每本书**会话**预算，默认 **$0.50**，0 表示不限制；
  - `AppSettings.chapterBudgetUsd`：**单章**预算，默认 **$0.20**，0 表示不限制。
- 计数：每轮 `message.usage.cost` 同时累加到会话成本和「当前章节」成本，随会话文件持久化
  （`chapterCosts`）——**重启不能绕过预算**。
- 归属：用户在 UI 里选中哪一章，发送的消息就带哪个 `chapterKey`，该轮成本记到这一章；
  没选章节时只计会话成本。
- 达到预算时：发 `budget_exceeded`（带 `scope: 'session' | 'chapter'`）→ 当前 run 结束后停止 →
  面板进入封锁态：
  - 会话超限：整个助手禁用，需调高预算或重置；
  - 单章超限：只封锁这一章，切到别的章节还能继续写。
- **预算预警**：阈值可配置（`AppSettings.budgetWarnRatio`，默认 0.8，范围 0.5–0.95，配置弹窗里改）。
  每轮结束若会话或当前章花费达到阈值且未超限，首次越过时弹一次 toast；
  面板底部常驻琥珀色预警条，显示已用百分比与金额，并带「调高预算」入口。预警只提示、不阻断。
- 实测：一句话问答约 $0.0005；把单章预算压到 $0.0001 后，该章立即进入封锁态。

### 6.3 历史会话渲染（含工具轨迹）

- 重启后不只提示"已恢复 N 条消息"，而是把历史对话渲染成正常气泡。
- 数据来源：主进程直接读 `session.json`，用 `toChatHistory()` 还原最近 40 条，经 `agent:session` IPC 返回。
- 工具轨迹：assistant 的 `toolCall` block 与后续 `toolResult` 按 `toolCallId` 配对，
  生成 `{ name, summary, ok }` 挂在对应气泡上——**刷新后不会丢**。
  - 摘要由 `src/agent/tool-summary.ts` 统一生成，实时轨迹与历史轨迹文案一致；
  - `isError` 决定显示 ✓ 还是 ×；
  - 只有工具、没有最终回答的轮次（比如中途关窗）也会保留轨迹，气泡正文为空。
- 超长工具结果仍按会话裁剪规则截断，但轨迹只存摘要，不占空间。

### 6.4 文风漂移检测

- 数据：`style_fingerprint.md` 里的指标表（本地统计，见 `src/shared/style.ts`）。
- 范围：正在查看的章节正文或草稿（编辑器里改动后会防抖 450ms 重算）。
- 规则（默认阈值）：平均句长偏差 >30%、平均段长 >40%、每百字标点数 >35%、对话占比绝对差 ≥15 个百分点。
- UI：文档标题旁出现「文风漂移 N 项」琥珀标签，点开看具体指标对比（当前 vs 指纹）。
- 漂移不阻断写作、不自动改稿——它是给作者的提示，不是规训。
- 纯函数在 `src/shared/style.ts`，主进程 IPC `style:drift` 负责读文件/算指标。

### 6.5 对话压缩（/compact）

- 入口：助手面板头部「压缩」按钮（手动触发），显示「压缩中…」；上下文占用 ≥70% 时提示「建议压缩」。
- 实现：pi 官方钩子 `transformContext` 的压缩用法（不是自造会话格式）：
  1. 按 token 预算从末尾保留最近若干轮（默认 ≤ 8k tokens，对齐到 user 边界）；
  2. 更早的消息用当前模型做一次单次调用（`completeSimple`，与 Agent 共用 provider/key/OpenCode 头）
     压成结构化摘要（写作目标 / 已确认设定 / 剧情进度 / 未解决伏笔 / 用户偏好）；
  3. 摘要以一条 `user` 消息（带 `[早期对话摘要]` 标记）插在 system 之后，替换被覆盖的消息；
  4. 原始消息仍完整保存在 `session.json`，UI 可回看，不会丢失。
- 持久化：`session.compaction = { summary, coveredMessages, createdAt }`；重启后继续生效。
- 再次压缩：把旧摘要与新消息合并，避免摘要套娃；没有可压内容时提示而不是空转。
- 安全：压缩只影响「发给模型的上下文」，不改正史、不改草稿；`重置` 会同时清空摘要。
- 实测：80 条历史 → 压缩 75 条，约 8k → 1k tokens，摘要 414 字；压缩后继续对话正常。

## 7. 测试策略

| 层 | 方式 | 进 CI |
|---|---|---|
| 会话裁剪/截断/预算判断 | `tests/session-state.test.ts` 纯函数单测 | ✅ |
| 工具 + Agent 循环 | pi 的 `fauxProvider` 脚本化响应，断言草稿真的落盘 | ✅ 不烧 token |
| 真实模型链路 | `tests/agent-live.test.ts`，检测到 key 才跑 | ❌ 无 key 自动 skip |
| 端到端（源码） | Playwright 驱动 Electron，真实调用一次并截图 | 手动 `npm run e2e:agent` |
| 工具摘要 | `tests/tool-summary.test.ts`：各工具的人话文案 | ✅ |
| 文风漂移 | `tests/style.test.ts`：指纹解析、阈值判断、方向与百分比 | ✅ |
| 端到端（会话/预算） | 两次启动验证记忆恢复 + 历史工具轨迹 + 预算封锁 | 手动 `node scripts/e2e-session.mjs` |
| 端到端（预算预警/阈值） | 预置 90% 会话，断言预警条；把阈值改到 95% 后预警消失 | 手动 `node scripts/e2e-budget-warn.mjs` |
| 端到端（文风漂移） | 用应用自身指标生成基线，验证贴合章节不报、偏离章节报 | 手动 `node scripts/e2e-style-drift.mjs` |
| 端到端（打包产物） | 直接启动 `release/win-unpacked` 里的 exe | 手动 `node scripts/e2e-packaged.mjs` |

## 8. 已知待办

- 多书并发：当前一次只保留一个 Host 进程；
- 会话导出/切换：一个书只有一个会话，还不能开分支对话；
- 工具轨迹目前只回显摘要，不展示工具返回内容（避免历史面板变成日志）；
- 预警阈值固定 80%，不能按项目配置。

## 9. 踩过的坑

| 坑 | 现象 | 解法 |
|---|---|---|
| ESM 里打包 CJS 依赖 | `Dynamic require of "buffer" is not supported`（isomorphic-git → sha.js → safe-buffer） | esbuild banner 注入 `createRequire`（见 `scripts/build-agent.mjs`） |
| utilityProcess 入口 | 需要独立 ESM bundle，electron-vite 不管这个入口 | 单独 esbuild 构建 `out/agent/host.mjs` |
| `ELECTRON_RUN_AS_NODE=1` | Electron 退化成 Node，`app` undefined | 启动前清除（e2e 脚本已处理） |
| 会话裁剪拆散工具对 | 从中间截断会让 `toolResult` 失去对应的 `toolCall` | 裁剪起点对齐到 `user` 消息 |
