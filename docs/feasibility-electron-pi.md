# 可行性评估：Electron + pi agent SDK

> 结论先行：**这套组合可行，而且相当合适。** 关键链路我都在本机实测过，不是查文档猜的。
> 真正的风险不在"能不能跑"，而在三处工程细节：进程边界、上下文成本、Git 集成方式。

## 0. 评估对象

| 项 | 选择 | 说明 |
|---|---|---|
| 外壳 | Electron | 用户已定（成熟度优先） |
| Agent 底层 | `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` | pi agent SDK，MIT |
| 数据 | Markdown 文件 + 每书 Git 仓库 | 沿用参考项目验证过的数据模型 |
| 目标 | Windows 本地小说创作客户端 | 不依赖 Dify / 自托管平台 |

> 注意包名：老 scope `@mariozechner/pi-*` 停在 `0.73.1`，现行包已迁到
> **`@earendil-works/pi-*` 1.4.0**。装错 scope 会拿到半年前的 API。实测有效。

## 1. 实测证据（本机，2026-10-23）

环境：Windows / Node v24.9.0 / npm；Electron 45.0.0 已下载并运行。

| 验证项 | 方法 | 结果 |
|---|---|---|
| 依赖安装 | `npm i @earendil-works/pi-agent-core@1.4.0 @earendil-works/pi-ai@1.4.0` | ✅ 86 个包，8 秒，**无原生模块** |
| Agent 循环 + 自定义工具 | faux provider 驱动的端到端脚本 | ✅ system→user→assistant→toolResult→assistant，工具真的执行了 |
| 事件流 | `agent.subscribe()` 收集事件 | ✅ `agent_start / turn_start / message_start / message_update / tool_execution_* / turn_end / agent_end` |
| 中断控制 | `agent.abort()` / `waitForIdle()` | ✅ 存在且可用 |
| 打包体积 | esbuild bundle（agent-core + deepseek + openai provider） | ✅ **单文件 1.40 MB**，0 警告 |
| 模型目录 | `models.getModels('deepseek')` | ✅ 内置目录可用（离线读取，不需要 key） |
| Electron 主进程内运行 | `npx electron main.mjs` 直接 import pi | ✅ `electron 45.0.0 / node 24.22.0 / chrome 156`，Agent 正常构造 |
| 运行时能力 | Electron 45 主进程内探测 | ✅ 全局 `fetch` 可用；**`node:sqlite` 内置可用**（SQLite 3.53.4） |

补充事实：

- pi 依赖里 `openai`(17.6MB) / `@google/genai`(10.8MB) / `@anthropic-ai/sdk`(9.1MB) / `@aws-sdk`(2.6MB) 是大头，
  全装 **66MB**；但只注册需要的 provider + esbuild 打包后只剩 **1.4MB** —— 体积完全不是问题。
- Electron 45 的 Node 是 24.22，满足 pi 的 `engines: node >= 22.19.0`。
- 本机环境有个坑：`ELECTRON_RUN_AS_NODE=1` 全局存在时会以纯 Node 模式启动 Electron
  （`app` 为 undefined，但 `process.versions.electron` 仍存在）。开发时要么清掉这个变量，要么别被它误导。

## 2. 为什么这套组合对"长篇小说客户端"是合适的

### 2.1 pi 提供的东西，正好是我们不想自己写的

| 我们的需求 | pi 直接给了 | 备注 |
|---|---|---|
| 多模型接入 | 内置 40+ provider 目录：OpenAI / Anthropic / Google / **DeepSeek** / **Moonshot(含国内)** / **ZAI** / **MiniMax** / **Qwen Token Plan** / 任意 OpenAI-compatible | 对中文网文场景非常关键 |
| 流式输出 | `streamSimple` / 事件流（text_delta、thinking_delta、tool 阶段） | 直接喂 UI |
| 工具调用循环 | `AgentTool` + TypeBox 参数校验 + 并行/串行执行 + `beforeToolCall`/`afterToolCall` 钩子 | 我们的"写文件/查章节/取上下文"都做成工具 |
| 中途干预 | `steer()`（工具执行中插话）/ `followUp()`（本轮结束后排队） | 写作场景极实用："这段别这么写" |
| 取消 | `abort()` | 长生成必须能停 |
| 上下文裁剪 | `transformContext()` 钩子 | 长篇必须自己做，但有正确挂点 |
| 成本核算 | 每条 message 的 `usage`：input / output / **cacheRead / cacheWrite** / cost | 能按章、按书算钱 |
| 会话持久化 | `Context` 与 `Model` 均可 `JSON.stringify` | 直接落 SQLite |
| 换模型续写 | 跨 provider handoff（context 可转移） | 便宜模型起草 → 贵模型润色 |
| 测试 | `fauxProvider()` 脚本化响应 | Agent 逻辑可做确定性单测，不用真调模型 |

### 2.2 参考项目的数据模型仍然成立

`draft/sandbox` 分支隔离 AI 写入、草稿包确认才切章、ETag 乐观锁、派生档案可重建——
这些和模型层完全解耦，换成 pi 之后照旧成立，**这是我们真正要抄的部分**。

### 2.3 Electron 相比 Rust 壳子的实际优势（对应你的判断）

- Node 生态直接可用（pi 是 Node-first 的 ESM 包，Tauri 里反而要桥接 Rust/HTTP）；
- 原生 `node:sqlite`、`fetch`、文件监听（chokidar）全都在主进程可用，**不需要为每个能力找 Rust 替代品**；
- 打包、签名、自动更新（electron-builder / electron-forge）成熟；
- 代价是安装包大（约 100MB 量级）——对写作工具完全可以接受。

## 3. 建议的架构（进程边界是关键）

pi 的 Agent 是一个"长跑循环"，**不要放在 Electron 主进程里跑**：
主进程阻塞会卡死窗口菜单、IPC 和所有窗口。

```text
┌─ Renderer (React) ────────────────────────────────────────┐
│ 三栏工作台：文件树 / Markdown 编辑 / Agent 对话           │
│ 只经 preload 暴露的 IPC 通道说话，不碰 fs/网络/密钥       │
└───────────────────────┬───────────────────────────────────┘
                        │ contextBridge（命令 + 事件流）
┌─ Main ─────────────────▼──────────────────────────────────┐
│ 窗口/菜单/生命周期、密钥读取（safeStorage）、              │
│ 打开项目、启动 Agent 宿主、转发事件                        │
└───────────────────────┬───────────────────────────────────┘
                        │ utilityProcess（推荐）或 worker_threads
┌─ Agent Host ──────────▼───────────────────────────────────┐
│ pi Agent 实例：模型调用、工具执行、上下文组装              │
│ 工具：read/write 文件、git 操作、章节检索、写草稿           │
└───────────────────────┬───────────────────────────────────┘
                        │
┌─ Core（纯 TS 库）──────▼──────────────────────────────────┐
│ 书库布局 / 草稿分支 / ETag 锁 / 归档切章 / 上下文 pack     │
│ 无 Electron 依赖，可单测（vitest）                         │
└───────────────────────────────────────────────────────────┘
```

理由：

- `utilityProcess` 是 Electron 官方给"跑重活/不可信代码"的进程模型，崩了不影响主进程；
- Agent Host 里可以安全放置 API Key（不出主进程之外的边界，渲染进程永远拿不到）；
- 事件流用 `MessagePort` 转 IPC，天然支持增量渲染、取消、重连。

**备选**：pi-ai 官方说支持浏览器环境，理论上可以全放 Renderer。
不推荐：密钥会进渲染进程，XSS/插件/DevTools 都能拿到，且渲染进程一刷新就丢会话。

## 4. 逐项可行性判定

| 维度 | 判定 | 依据 / 备注 |
|---|---|---|
| Agent 框架 | ✅ 高 | 实测循环、工具、事件、中断全部可用 |
| Electron 集成 | ✅ 高 | Electron 45 主进程内实测构造成功；ESM 直跑 |
| 模型接入（国内） | ✅ 高 | DeepSeek/Moonshot/ZAI/MiniMax/Qwen 均内置目录 |
| 流式体验 | ✅ 高 | `message_update` 增量 + 工具阶段事件 |
| 成本控制 | ⚠️ 中 | pi 有 usage/缓存统计，但**上下文组装策略必须我们自己设计** |
| 长文本上下文 | ⚠️ 中 | 106KB 的 API 文档里没有"自动压缩"成品；靠 `transformContext` 自制 |
| Git 集成 | ⚠️ 中 | 需在两方案间选：`isomorphic-git`(纯 JS) vs `simple-git`(依赖 git.exe) |
| 持久化 | ✅ 高 | Electron 45 自带 `node:sqlite`，免原生编译 |
| 打包分发 | ✅ 高 | electron-builder；注意 Windows 签名成本 |
| 自动化测试 | ✅ 高 | faux provider 让 Agent 可测；UI 用 Playwright |
| 版本稳定性 | ⚠️ 中 | pi 处于 1.x 快速迭代期，需锁版本 + 抽象一层适配 |

## 5. 三个必须先做 POC 的点（按风险排序）

1. **上下文成本模型**（最高风险）
   一本 200 章的书，没法整本塞进去。需要设计"章节上下文包"：
   当前章大纲 + 前 N 章摘要 + 世界观切片 + 状态卡 + 文风约束 + 相关错误档案，
   并用 pi 的 `cacheRead/cacheWrite` 统计验证 prompt cache 命中率。
   POC 目标：单章续写的输入 token 稳定在可控区间，且价格可算。

2. **Git 方案二选一**
   - `isomorphic-git`（1.44.3，纯 JS）：不依赖用户装 Git，安装包不加 50MB；但大仓库/频繁提交性能需实测。
   - `simple-git`（4.0.2）+ 打包便携版 Git：行为与命令行一致、性能好；代价是体积和 Windows 路径/编码坑（参考项目就在这吃过亏）。
   POC 目标：1000 次提交 + 分支切换 + diff 的耗时；中文文件名/路径。

3. **真实模型流式写入链路**
   用一家国内 provider（DeepSeek 或 Qwen）跑通"读上下文 → 生成 3000 字 → 写草稿文件 → 事件流到 UI"，
   验证：取消、断流重试、错误提示、token 统计、并发写冲突（ETag 409）。

## 6. 风险清单与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| pi 1.x API 变动 | 中 | 锁定精确版本；在 `core` 与 pi 之间加一层 `agent-runtime` 适配接口 |
| ESM-only 包 | 低 | 主进程/utilityProcess 用 ESM 或 esbuild 打包；实测均可行 |
| `ELECTRON_RUN_AS_NODE` 干扰 | 低 | 开发脚本里显式清除该变量 |
| 密钥安全 | 高 | `safeStorage` 加密存本地；只在 Agent Host 内使用；日志脱敏 |
| 上下文失控/费用失控 | 高 | 每次请求前打印预估 token 与成本；设置单章/单次上限；缓存策略 |
| 工具误写文件 | 高 | 所有写操作走 `beforeToolCall` 校验 + 只写 `draft/sandbox` 分支 + ETag 锁 |
| Windows 编码/换行 | 中 | 全链路 UTF-8；仓库级 `.gitattributes`；测试固定 `core.autocrlf=false` |
| 安装包体积 | 低 | 估算 100–150MB，可接受；只打包目标平台 |
| Windows 代码签名 | 中 | 未签名会有 SmartScreen 提示；发布前准备证书 |

## 7. 建议的技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 构建 | electron-vite 6 | 主/预加载/渲染三端一套配置，HMR 快 |
| 打包 | electron-builder 26 | NSIS 安装包 + 自动更新成熟 |
| UI | React 19 + TypeScript + Tailwind | 与参考项目同构，团队熟悉 |
| 编辑器 | CodeMirror 6 或 TipTap | Monaco 太重，小说正文不需要 IDE 能力 |
| 状态 | zustand | 轻，够用 |
| 存储 | `node:sqlite`（Electron 45 内置） | 免原生编译；只做索引，真相仍是文件 |
| Git | isomorphic-git（先） | 零外部依赖，安装体验最好 |
| 密钥 | `safeStorage` | 系统级加密，Windows DPAPI |
| 测试 | vitest（core）+ Playwright（E2E） | pi 的 faux provider 覆盖 Agent 逻辑 |
| Agent | `@earendil-works/pi-agent-core` 1.4.0 | 锁版本 |

## 8. 最终判断

**技术上没有拦路虎。** 这套栈的每一块都有成熟实现，pi 补齐了最麻烦的"模型接入 + 流式 + 工具循环"。

真正决定成败的是**产品层面的数据设计**——上下文怎么组装、草稿和正史怎么隔离、
审核与回滚怎么让作者看懂。这些恰好是参考项目做得最好的部分，值得整套借过来。

建议的推进顺序：

1. 写 `docs/design.md`（书库布局、文件语义、状态机、IPC 协议）——不写代码；
2. 搭 Electron 骨架 + 三栏 UI 空壳（无 AI）；
3. 做"导入 → 浏览 → 编辑 → 手动归档"闭环（仍然无 AI，证明数据层）；
4. 接 pi：单章续写 → 工具写入草稿分支 → 审核 → 归档；
5. 补上下文成本控制与错误档案。
