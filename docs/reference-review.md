# 参考项目对照评审：哪些值得抄，哪些是坑

> 对象：`../reference/novel_agent`（blackzhanzhan/novel_agent，89 次提交，全部为 2026-05 的公开快照）
> 目的：给 `novel_studio`（桌面客户端 / 不依赖 Dify）做取舍，不是做兼容。
> 证据均为本地实际跑过的结果，不是读 README 转述。

## 一句话结论

**数据模型和"AI 写入隔离"这套设计值得整套抄走；工程组织和运行时依赖必须全部换掉。**

它把"AI 写小说"这件事拆成了可审计的文件 + Git 语义，这是真正值钱的部分；
但它的运行时被 Dify 锁死，代码长成了 3000 行的单文件，测试和实现对不上——
这三点正好是我们做客户端要避开的。

---

## 一、值得抄的（设计层面）

### 1. 一本书 = 一个目录 + 一个独立 Git 仓库

`novel_git_server/storage/<book_id>/` 里就是全部真相：`.git/` + Markdown 文件。
没有中心数据库。好处：

- 用户可以随时 `git log` / 用别的编辑器打开 / 打包带走，不被应用锁死；
- "剧情分支"是真的 `git branch`，"回退"是真的 reset，不需要自己实现版本树；
- 删掉应用不丢稿。

**落地建议**：照抄，但 `book_id` 用确定性 slug+hash（它用了 `pypinyin` + `md5[:8]`，很实用）。

### 2. AI 写入落在独立分支 `draft/sandbox`

证据：`novel_git_server/utils/draft_metadata.py:10`，`DRAFT_BRANCH_NAME = "draft/sandbox"`。

Agent 写的东西进 `draft/sandbox` 分支，主线（mainline）保持"已接受的正史"。
人工确认后才合入/归档。这一条是它最值钱的设计：

- AI 乱写不会污染正史；
- 想对比两条剧情线，直接开两个分支；
- 审核看的是分支 diff，不是"聊天记录里说了啥"。

**落地建议**：照抄，而且要在客户端里做成可见的"草稿层 / 正史层"两个视图。

### 3. 草稿 ≠ 章节：`chapter_draft.md` 是"草稿包"，确认才切章

`chapter_draft.md` 里可能一次写了好几章，作者确认后后端才把它按标题切分成
`chapters/0001_xxx.md`、`0002_xxx.md` 并提交（见 `docs/TECHNICAL_DOSSIER.md` 的"正文化归档"链路）。

这解决了一个真问题：模型一次吐三章，你不能让它直接决定章号和文件名。

**落地建议**：照抄这个"草稿包 → 人工确认 → 切分归档"的三段式。

### 4. ETag 乐观锁：解决"人正在改，AI 也来写"

证据：`agents/archive.py` 里 `_normalize_base_etag` / `base_etag` / `409` 冲突返回。

每个文件读取时带 ETag，写回时必须带 `base_etag`；不匹配就 409 并给出 diff 提示。
对客户端来说是刚需：用户开着编辑器，Agent 后台又在改同一份 `world_model.md`。

**落地建议**：照抄语义，实现上换成"文件内容 hash + 版本号"即可。

### 5. 派生档案必须由确定性代码生成，不能交给模型自由覆盖

`summary.md`（阅读摘要）、`status_card.md`（当前状态投影）、文风三件套
（`style_fingerprint.md` / `style_review.md` / `style_constraints_for_continuation.md`）
都从"后端可重复管线"生成，而不是让 Agent 聊天时随手写。

**落地建议**：照抄原则。凡是"能从已有章节推导出来"的，都用代码 + 一次性模型调用生成，
并且允许一键重建（重建结果应当可复现）。

### 6. 负向记忆：`error_archive.md`

作者的纠错、禁止的写法、审核发现的问题，沉淀成一个文件，续写时作为约束注入。
参考项目把它做成了"可复用的问题库"，不是聊天历史。

**落地建议**：照抄，甚至可以结构化（每条：现象 / 原因 / 规避规则 / 来源章节）。

### 7. 控制器与执行器分离（rolling 三章生产）

`pipelines/rolling_chapter.py` + `agents/rolling.py` 只做"下一步写哪几章"的调度，
不生成正文。卡不够就提示补纲，不硬写。

**落地建议**：客户端里对应"任务队列 / 生产看板"，Agent 只负责执行单步。

### 8. 前端交互骨架可借鉴（实现别抄）

三栏：左侧文件树（按"核心记忆 / 剧情总纲 / 大纲"分组）→ 中间 Markdown 正文 + ETAG
→ 右侧 Agent 对话；底部动作条（动作 / 指令输入）。
这个信息架构是对的，作者/Agent 的注意力分配合理。

---

## 二、是坑的（工程层面，我们必须避开）

### 1. Dify 硬绑定 —— 最大的坑

- 6 个 Agent 工作流是 Dify DSL（`dify_workflows/*.yml`），导入不等于可运行；
- 需要 Dify 自己的 PostgreSQL、插件、模型供应商、App API Key；
- Dify 容器里的 Agent 要反过来通过 ToolProvider 回调本地 Flask（`host.docker.internal`），
  这是最容易断的一环，参考项目 406 行部署文档里有 4 条踩坑记录都是这个；
- 本地启动脚本默认要 WSL Ubuntu + `docker compose` 起 Dify（`start_all.ps1`）。

**结论**：桌面客户端必须**内置 Agent 循环**（直连模型 API，或你选的 "pi" 底层），
Dify 这类"外部编排平台"最多作为可选后端，不能作为唯一入口。

### 2. 巨型单文件，职责过载

| 文件 | 行数 | 问题 |
|---|---|---|
| `frontend/src/App.tsx` | 2996 | 装配 + 状态 + 引导 + 编辑 + Git 展示全塞一起 |
| `agents/world_draft.py` | 2468 | SSE 桥接 + 文件路由 + 草稿写入 + 迁移警告 |
| `agents/archive.py` | 2048 | 读/写/ETag/归档/区块写入都在一个 blueprint |
| `pipelines/rolling_chapter.py` | 1319 | 调度 + 解析 + 提示词拼装 |
| `components/ProseDeliveryWorkbench.tsx` | 990 | 单个工作台组件 |

**结论**：新项目第一步就把边界定死（领域层 / 存储层 / Agent 层 / UI 层），
单文件超过 ~400 行就该拆。

### 3. 89 个 REST 端点 + 14 个前端 api 模块

对 Web 服务是合理的；对**桌面客户端**是错的。Tauri/Electron 里应该是
"命令式 IPC + 少量流式事件"，而不是自己给自己起一个 HTTP 服务再调回来
（多一层端口、跨域、防火墙、进程管理）。

### 4. 测试与代码漂移（本地实测）

- 干净环境跑 409 个测试：**34 failed / 5 errors**（522 秒），README 说 426 个测试；
- 主要不是环境问题：读接口已改成"无副作用 + 显式 `/books/repair_layout`"，
  但 `test_v31_addressing`、`test_v52_git_graph` 等仍按"读的时候自动自愈"写；
- 有一批失败是 Windows 下 subprocess 抓 git 输出按 GBK 解码导致（`PYTHONUTF8=1` 可解）；
- 另有环境前提没写清：**机器必须配好 git user.name/email**，否则全部提交类测试 128 失败
  （我这边首轮因此产生 194 个 error）。

**结论**：新项目从第一天就把"测试跑绿"写进 CI，不留"资产数量"式的测试。

### 5. Windows / 环境脆弱

- git 身份、编码、路径分隔、换行（`core.autocrlf`）都会影响行为；
- 部署依赖 WSL + Docker + 端口探测 + 419 行启动脚本 + 体检器；
- 这些都是"Web 服务时代"的复杂度。

**结论**：桌面客户端把环境问题吃掉（内置运行时、内置 git 库、固定数据目录）。

### 6. 双份真相：`.loregit/prose_delivery_state.json`

正文交付状态（草稿切片 / 审核结论 / 打回次数 / 归档接棒）存在书本目录下、
但**被 gitignore**、不进版本历史。这个文件与 `chapter_draft.md` 一旦不同步，
就会出现"状态说有 3 章、文件里只有 2 章"的鬼故事。

**结论**：要么把它纳入版本控制，要么做成可重建缓存（从文件 + git 重新推导）。

### 7. 工程卫生

- **没有 LICENSE**（公开仓库无授权声明）；
- CI 只做 Pages 部署和镜像构建，**不跑测试**；
- 历史被压成一个 `chore: publish clean open source snapshot`，无法追溯决策；
- 仓库根挂了一套与产品无关的 "Cyber-Ming" 流程文件（`AGENTS.md` / `dev_repo/`），
  实际运行态文件并不存在 —— 说明这套流程没真正用起来。

---

## 三、映射到我们的项目（桌面客户端 / 无 Dify）

| 参考项目做法 | 我们怎么办 |
|---|---|
| 一本书 = 目录 + 独立 git 仓库 | **保留**（真相层） |
| Markdown 语义文件（world/summary/status/outline/style/error） | **保留**，但用 schema 校验，防止字段漂移 |
| `draft/sandbox` 分支隔离 AI 写入 | **保留**，UI 明确区分"草稿层 / 正史层" |
| ETag 乐观锁 | **保留**，改为内容 hash + revision |
| 草稿包 → 确认 → 切章归档 | **保留** |
| Dify Agent 编排 | **替换**：内置 Agent 循环（直连模型 / 你指定的 "pi"） |
| LoreGit ToolProvider（反向 HTTP 回调） | **删除**：客户端内直接调用工具函数 |
| 89 个 REST 端点 | **替换**：IPC 命令 + 事件流 |
| 公开体验版 / cookie 沙箱 / 公网代理 | **删除**：不做多租户 |
| `start_all.ps1` / 动态端口 / 体检器 | **删除** |
| 巨大单文件 | **禁止**，先定分层 |
| 手工维护的双份状态文件 | **不抄**，状态可重建 |

### 桌面形态的初步建议

- **外壳**：Tauri 2（体积小、内存低、Rust 侧能直接拿 `git2` 操作仓库），
  Electron 只有在必须复用 Node 生态时才选。
- **核心层**：Rust（文件 / Git / 版本 / 索引 / 迁移）+ 可选的本地 Python sidecar
  （仅当"pi"是 Python 生态时才需要）。
- **数据**：Markdown 是唯一真相；SQLite 只做索引与全文检索，随时可重建。
- **Agent 层**：进程内编排（工具调用 + 流式输出），凭据存在系统钥匙串，不进仓库。
- **前端**：React + 三栏工作台，复用参考项目的**信息架构**，代码从零写。

---

## 四、需要先确认的三件事

1. **"pi" 具体指什么？**（候选：① 直连模型 API 的自研 provider 抽象；② Python 运行时；
   ③ 某个现成框架/CLI）。这决定了核心层是纯 Rust 还是 Rust + Python sidecar。
2. **外壳选 Tauri 还是 Electron？**
3. **首个 MVP 交付什么？** 建议先做"导入现有稿子 → 浏览/编辑 → 手动起草 → 确认归档"
   的闭环（不含 AI 也成立），第二步再接 Agent 续写。
