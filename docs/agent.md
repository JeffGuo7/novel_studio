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
| `read_knowledge` | 读 | 读白名单知识文件 |
| `list_drafts` | 读 | 草稿版本列表 |
| `book_history` | 读 | 正史提交历史 |
| `write_draft` | **写草稿** | 唯一写入口，落到 `.studio/drafts/<key>/vNNN.md` |

**没有"归档"工具**——这是刻意的。归档只能由作者点按钮触发（`promoteDraft`），
Agent 即使被提示词注入也没有能力把草稿变成正史。

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
- 实测：一句话问答约 $0.0005；把单章预算压到 $0.0001 后，该章立即进入封锁态。

### 6.3 历史会话渲染

- 重启后不只提示"已恢复 N 条消息"，而是把历史对话渲染成正常气泡。
- 数据来源：主进程直接读 `session.json`，用 `toChatHistory()` 提取 `user / assistant` 的文本
  （跳过 `toolResult` 与空的 toolCall 消息），经 `agent:session` IPC 返回最近 40 条。
- `session_restored` 事件仍在「重置」时用于清空 UI 的计数。

## 7. 测试策略

| 层 | 方式 | 进 CI |
|---|---|---|
| 会话裁剪/截断/预算判断 | `tests/session-state.test.ts` 纯函数单测 | ✅ |
| 工具 + Agent 循环 | pi 的 `fauxProvider` 脚本化响应，断言草稿真的落盘 | ✅ 不烧 token |
| 真实模型链路 | `tests/agent-live.test.ts`，检测到 key 才跑 | ❌ 无 key 自动 skip |
| 端到端（源码） | Playwright 驱动 Electron，真实调用一次并截图 | 手动 `npm run e2e:agent` |
| 端到端（会话/预算） | 两次启动验证记忆恢复 + 预算封锁 | 手动 `node scripts/e2e-session.mjs` |
| 端到端（打包产物） | 直接启动 `release/win-unpacked` 里的 exe | 手动 `node scripts/e2e-packaged.mjs` |

## 8. 已知待办

- 多书并发：当前一次只保留一个 Host 进程；
- 会话导出/切换：一个书只有一个会话，还不能开分支对话；
- 历史消息里的工具调用轨迹没有回显（只还原纯文本对话）；
- 预算提醒：目前只有"用尽即停"，还没有 80% 预警。

## 9. 踩过的坑

| 坑 | 现象 | 解法 |
|---|---|---|
| ESM 里打包 CJS 依赖 | `Dynamic require of "buffer" is not supported`（isomorphic-git → sha.js → safe-buffer） | esbuild banner 注入 `createRequire`（见 `scripts/build-agent.mjs`） |
| utilityProcess 入口 | 需要独立 ESM bundle，electron-vite 不管这个入口 | 单独 esbuild 构建 `out/agent/host.mjs` |
| `ELECTRON_RUN_AS_NODE=1` | Electron 退化成 Node，`app` undefined | 启动前清除（e2e 脚本已处理） |
| 会话裁剪拆散工具对 | 从中间截断会让 `toolResult` 失去对应的 `toolCall` | 裁剪起点对齐到 `user` 消息 |
