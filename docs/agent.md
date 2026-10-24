# Agent 层设计（pi 基座）

> 这一层回答一个问题：**模型怎么安全地参与创作。**
> 结论：Agent 只能"读"和"写草稿"，正史归档永远是人类动作。

## 1. 进程边界

```text
renderer（React）
  └─ IPC 事件/命令
main（Electron）
  ├─ AgentManager：每个书目录一个 utilityProcess，切书即重建
  └─ 密钥：从 .env.local 读入，只通过子进程 env 传递，不进渲染层
utilityProcess（Agent Host，out/agent/host.mjs）
  ├─ pi-agent-core 的 Agent 循环（模型调用 / 流式 / 工具 / 中断）
  ├─ tools：直接调用 core 领域层（同一台机器、同一份磁盘）
  └─ 事件：status / assistant_delta / tool_start / tool_end / book_changed
```

为什么不用主进程：模型调用 + 工具执行是一段长循环，放在主进程会拖慢窗口/IPC；
`utilityProcess` 崩溃也不会带走整个应用。**实测** Electron 45 的 utilityProcess 能直接跑
ESM 版的 pi（bundled 后 2MB），Node 24.22。

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
{ type: 'ready', info: { model, provider, bookTitle } }
{ type: 'event', event: AgentEvent }
{ type: 'fatal', message }
```

Main → Renderer（`agent:event`）：`status / assistant_delta / assistant_done /
tool_start / tool_end / turn_end(usage) / book_changed / error`

`book_changed` 让 UI 在 Agent 写完草稿后自动刷新书架与草稿列表，
并提示"Agent 写了第 N 章草稿 vX，正史未改动"。

## 4. 模型与密钥

- 默认 **`deepseek-flash`**（便宜、够用）；`.env.local` 的 `NOVEL_STUDIO_MODEL` 可切换
  `deepseek-v4-pro`（更贵）。
- Key 只在 `.env.local`（gitignore），main 读取后通过子进程 env 传给 Host，
  渲染进程永远拿不到；日志不打印 key。
- 成本：每轮 usage 从 pi 的 `message.usage` 读取，UI 显示 `in / out / $cost`。

## 5. 中断与干预

- `abort()`：停止当前生成；
- `steer()`：生成过程中插话，Agent 在下一个 turn 边界改道；
- `reset()`：清空 Agent 记忆（不动书稿）。

## 6. 测试策略

| 层 | 方式 | 进 CI |
|---|---|---|
| 工具 + Agent 循环 | pi 的 `fauxProvider` 脚本化响应，断言草稿真的落盘 | ✅ 不烧 token |
| 真实模型链路 | `tests/agent-live.test.ts`，检测到 key 才跑 | ❌ 无 key 自动 skip |
| 端到端 | Playwright 驱动 Electron，真实调用一次并截图 | 手动 `npm run e2e:agent` |

## 7. 已知待办

- 会话持久化：pi 的 `Context` 可序列化，尚未落盘（重启后 Agent 记忆丢失）；
- 多书并发：当前一次只保留一个 Host 进程；
- 模型切换 UI：目前靠 `.env.local`，后续进"本机配置"面板；
- 成本上限：还没做单次/单章预算熔断。

## 8. 踩过的坑

| 坑 | 现象 | 解法 |
|---|---|---|
| ESM 里打包 CJS 依赖 | `Dynamic require of "buffer" is not supported`（isomorphic-git → sha.js → safe-buffer） | esbuild banner 注入 `createRequire`（见 `scripts/build-agent.mjs`） |
| utilityProcess 入口 | 需要独立 ESM bundle，electron-vite 不管这个入口 | 单独 esbuild 构建 `out/agent/host.mjs` |
| `ELECTRON_RUN_AS_NODE=1` | Electron 退化成 Node，`app` undefined | 启动前清除（e2e 脚本已处理） |
