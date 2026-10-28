# Novel Studio

<img src="docs/assets/logo.png" width="96" alt="Novel Studio logo" />

[![CI](https://github.com/JeffGuo7/novel_studio/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffGuo7/novel_studio/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JeffGuo7/novel_studio?display_name=tag&sort=semver)](https://github.com/JeffGuo7/novel_studio/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CodeQL](https://github.com/JeffGuo7/novel_studio/actions/workflows/codeql.yml/badge.svg)](https://github.com/JeffGuo7/novel_studio/actions/workflows/codeql.yml)

[English](README.en.md) · 简体中文

本地优先的 AI 小说创作工作台。**Markdown 是唯一真相，Git 管正史，草稿走独立版本，AI 永远不能自己归档。**

Electron + React + TypeScript + isomorphic-git + [pi agent SDK](https://github.com/earendil-works/pi)。
书稿存在你自己的磁盘上，模型只在你主动发起的那一轮对话里看到它。

![书架](docs/assets/bookshelf.png)

![写作统计](docs/assets/stats.png)

## 下载安装

> 第一次使用？看 [从安装到第一本书（使用手册）](docs/getting-started.md)，10 分钟跑通全流程。

Windows x64：到 [Releases](https://github.com/JeffGuo7/novel_studio/releases) 下载
`Novel Studio-Setup-<版本>-x64.exe` 安装，或下载 `Portable` 版直接运行。

> 安装包目前**未做代码签名**，Windows SmartScreen 提示"未知发布者"属正常现象；
> 发布页附带 `SHA256SUMS.txt`，可自行校验。首次启动后点右上角「配置」填入模型 API Key
> （DeepSeek / OpenCode / OpenAI / Anthropic / 任意 OpenAI 兼容端点），即可新建书开始写。

## 它解决什么问题

用 ChatGPT/Claude 写小说，常见崩点不是"模型写不好"，而是工程问题：

| 问题 | 这个项目的做法 |
|---|---|
| AI 改过的稿子覆盖了原文，想找回 | 每次保存/归档都是 Git 提交，可 diff、可回滚 |
| AI 草稿混进正文 | 草稿存在 `.studio/drafts`，不进 Git；只有作者点「归档」才成为正史 |
| 模型不了解前文设定 | 知识库（世界观/状态卡/总纲/大纲/文风 + 人物·地点·势力卡 + 卷摘要）随上下文注入，超长书自动分块蒸馏 |
| 写着写着不像自己了 | 文风指纹 + 文风漂移检测 |
| token 花费失控 | 会话/单章双预算，超限硬停，重启不能绕过；到阈值预警 |
| 换台机器/重装就丢历史 | 全部文件 + 嵌套 Git，拷走目录即可 |

## 功能

**书架**

- 搜索（书名/作者/简介）、排序（最近打开/最新创建/书名）、最近打开排序
- 编辑书名/作者/简介；上传封面（PNG/JPG/WebP，≤2.5MB）；修改书名不移动目录，不破坏书库路径

**写作与版本**

- 书架、章节、知识文件（世界观 / 状态卡 / 剧情总纲 / 四层大纲 / 文风 / 错误档案），全部 Markdown
- 章节保存即提交；历史时间线、词级 diff、回滚（回滚也生成新提交，历史不丢）
- 草稿独立多版本，可查看任意版本、以旧版为基线继续写、归档成章、整章丢弃
- **章节管理**：插入（上方/下方）、上移/下移、合并到下一章、按编辑器光标拆分、重新编号；草稿、知识管线 hash、会话成本、搜索索引一起迁移
- **自动存档 / 崩溃恢复**：编辑中 2.5 秒无输入自动落盘（`.studio/autosave`），重开应用时提示「恢复/丢弃」，保存成功后自动清除
- **全书搜索 / 替换**：`Ctrl/Cmd + F` 搜索章节与知识文件，点击定位；支持区分大小写、按文件/全书替换，替换生成一次 `[替换]` Git 提交
- 删除：删章节会生成 `[删除]` 提交（历史可找回）；整本书移到书库 `.trash` 回收站，不直接销毁
- **写作统计**：顶栏「统计」→ 今日新增 / 总字数 / 连续写作天数 / 每日目标进度 / 最近 14 天柱状图；数据存 `.studio/stats.json`（只统计正文章节，删除不扣负）
- **导出**：整本导出 Markdown（合并单文件）/ TXT（去掉标记）/ EPUB（标准电子书、自动目录），只包含正式章节、不包含草稿

**导入**

- 粘贴文本、本地多文件批量、番茄书源（适配本机下载器，可选）
- 自动识别 UTF-8 / GB18030，按「第 N 章 / 序章 / 楔子 / Chapter N」切章，一次导入一个提交

**知识库管线**

- 初始化：把章节蒸馏成 剧情总纲 / 世界模型 / 状态卡 / 逐章大纲 / 文风指南 / 文风指纹
- 增量更新：只处理新增章节，状态卡滚动更新
- 失效重建：给每章记内容 hash，旧章节被改写/删除时提示整本重建；**重建属于大改动，不会直接覆盖已有知识文件，而是生成 AI 建议，作者在「AI 建议」里看 diff、接受后才落盘**
- 文风指纹本地统计（句长/段长/对话占比/人称/高频意象），模型只做解读，不编数字

**Agent（pi 基座）**

- 独立 `utilityProcess`；工具只有「读上下文 / 读章节 / **剧情检索** / 写草稿」，**没有归档与删除权限**
- 流式输出、中断、插话；会话持久化，重启后在 UI 里还原对话气泡和工具轨迹
- 成本统计：会话 + 单章双预算，超限封锁输入；阈值预警可配置（默认 80%）
- 上下文预算由模型驱动：按 `contextWindow / maxTokens` 推导，自动裁剪历史与上下文包，面板显示占用
- **对话压缩 /compact**：一键把较早轮次压成结构化摘要（原文仍保留），长对话不爆上下文
- **上下文溢出兜底**：请求因上下文超限失败时，自动折叠早期消息、临时缩小输入预算并重试一次；仍失败才提示手动压缩或换模型
- **剧情检索 search_story**：本地全文索引（MiniSearch + 中文 1/2-gram），同时索引章节正文与人物卡/地点卡/势力卡/卷摘要等知识文件；支持按章节范围过滤，几百章也能按人物/地名/事件找回旧情节，**不需要 embedding 模型**
- **自动更新**：从 GitHub Releases 检查新版本，下载后校验 SHA256，由你确认再安装
- **连接测试 + 应用内代理**：设置页一键测试模型连通性（区分鉴权/网络/模型错误），支持 HTTP 代理，同时作用于模型请求与更新检查
- **数据安全**：整个书库（含每本书的 .git 历史）本地 zip 备份/恢复；**自动备份**（默认每 3 天，保留最近 5 份，手动备份不清理）；恢复时可只选其中几本书，同名书跳过、不覆盖
- **可观测性**：结构化 JSONL 日志 + 渲染进程错误边界 + 崩溃兜底页；日志只存本地，可在设置里打开
- **章节字数缓存**：`.studio/cache/chapters.json` 按文件 size/mtime 增量维护字数，大书快照不再重读全书（1000 章：冷启动 197ms → 热读取 67ms）
- **AI 知识建议**：Agent 只能 propose_knowledge 提建议，你在「AI 建议」里逐条看 diff、接受后才写入正史并提交
- **大纲向导**：一句话创意 → 主线 / 分卷 / 世界模型建议，同样走 diff 审阅后再落盘

**一致性检查（只读审稿）**

- 顶栏「一致性」→ 选章节范围 / 重点关注 → 模型逐条找人物、时间线、设定、剧情矛盾，按高/中/低分级输出，报告存 `.studio/reviews`
- **只读**：不修改书稿、知识文件或 Git 历史；是否修改由作者决定

**文风漂移**

- 正在看的章节/草稿与文风指纹对比，句长/段长/对话占比偏离阈值时标题旁提示，可查看具体偏差

**分发**

- `npm run release` 一条命令出 NSIS 安装包 + 便携版 + SHA256 校验和 + 发行说明
- 当前版本**未做代码签名**（SignPath Foundation 因项目社区可见度不足暂未通过，后续可重新申请；也可选用 Certum 开源证书付费方案）。SmartScreen 会提示未知发布者，可按 SHA256 校验后运行

![工作台](docs/assets/workbench.png)

![导出书稿](docs/assets/export.png)

![章节管理](docs/assets/chapter-menu.png)

![自动存档恢复](docs/assets/autosave.png)

![全书搜索](docs/assets/search.png)

![模型连接测试](docs/assets/connection.png)

![一致性检查](docs/assets/review.png)

![Agent 续写](docs/assets/agent-draft.png)

![知识库](docs/assets/knowledge-done.png)

![文风漂移](docs/assets/style-drift-detail.png)

## 快速开始

要求：Node.js ≥ 20（开发用 24）、Windows 10/11。

```powershell
npm install
copy .env.example .env.local     # 可选：也可以启动后在「本机配置」里填 API Key
npm run dev                      # 开发模式（热更新）
```

首次启动 →「本机配置」选 provider / 模型 / 填 Key → 新建书 → 写或导入章节 → 让 Agent 续写。

默认模型是 `deepseek-flash`（便宜、够用）；模型目录内置 pi 的完整清单（41 个 provider / 1599 个模型），
也支持自定义 OpenAI 兼容 endpoint。OpenCode Zen / Go 也内置：Go 套餐选 `opencode-go`
即可（应用会自动附加 `x-opencode-session` 会话路由头）。

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式 |
| `npm run build` | 构建应用 + Agent/知识库两个 utilityProcess bundle |
| `npm test` | 单测（216 个，含 faux provider，不烧 token） |
| `npm run typecheck` | 类型检查 |
| `npm run release` | 打包安装包 + 便携版 + 校验和 + 发行说明 |
| `npm run e2e:agent` | 真实模型端到端（需要 key，会花钱） |
| `npm run e2e:window` | 回归：Agent 推流中关窗不能崩 |
| `npm run e2e:budget` / `e2e:drift` | 预算预警 / 文风漂移 UI 端到端（不花钱） |
| `npm run e2e:compact` | 对话压缩端到端（真实摘要调用一次） |
| `npm run e2e:search` | 剧情检索端到端（真实模型会调用 search_story） |
| `npm run e2e:smoke` | UI 冒烟：截图 + 设置/备份/恢复（不花钱） |
| `npm run lint` / `npm run test:coverage` | oxlint / 覆盖率（逻辑层门槛 70%） |
| `npm run doctor:update -- --download` | 更新链路演练：检查 Release + 下载 + 校验 SHA256 |
| `npm run eval:retrieval` | 检索质量评估（CI 门槛：hit@5 100%） |
| `npm run e2e:export` | 导出端到端（Markdown / TXT / EPUB，不花钱） |
| `npm run e2e:chapters` | 章节管理端到端（插入/移动/合并/拆分/重编号，不花钱） |
| `npm run e2e:autosave` | 自动存档 / 崩溃恢复端到端（不花钱） |
| `npm run e2e:book-search` | 全书搜索 / 替换端到端（不花钱） |
| `npm run e2e:bookshelf` | 书架搜索/排序/书籍信息/封面上传端到端（不花钱） |
| `npm run e2e:stats` | 写作统计与每日目标端到端（不花钱） |
| `npm run e2e:review` | 一致性检查端到端（需要 key，低成本） |
| `npm run e2e:connection` | 真实模型连接测试 + 代理（需要 key，极低成本） |

## 键盘快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl/Cmd + F` | 全书搜索 / 替换 |
| `Ctrl/Cmd + S` | 保存当前章节 / 知识文件 |
| `Enter` | 发送 Agent 消息 |
| `Shift + Enter` | 消息内换行 |
| `Esc` | 关闭弹窗；Agent 生成中按 `Esc` 中断 |
| `Tab / Shift + Tab` | 弹窗内焦点循环，不跑到背景 |
## 数据与隐私

| 内容 | 位置 |
|---|---|
| 书库（Markdown + 嵌套 Git） | `%USERPROFILE%\Documents\NovelStudio`，可用 `NOVEL_STUDIO_HOME` 覆盖 |
| 配置（模型、预算、加密后的 Key） | `%APPDATA%\Novel Studio\settings.json`，可用 `NOVEL_STUDIO_USER_DATA` 覆盖 |
| Agent 会话 | `<书>/.studio/agent/session.json`（`.studio` 已在书库 Git 里忽略） |

- API Key 用系统 safeStorage 加密存在本机，不写书库、不发给渲染进程以外的进程；
- 只有你主动发起的模型请求会出网；应用没有遥测、没有云端账号；
- 番茄书源只连你本机的下载器（`127.0.0.1:18423`），本程序自己不爬站。

## 架构

```text
┌──────────────────────────── renderer (React) ────────────────────────────┐
│ 书架 / 工作台 / 助手 / 配置 / 导入 / 文风漂移                            │
└───────────────────────────────┬──────────────────────────────────────────┘
                     contextBridge (preload) │ 类型化 IPC
┌───────────────────────────────┴──────────────────────────────────────────┐
│ main (Electron)                                                          │
│  books / git / drafts  IPC · settings(safeStorage) · PipelineManager     │
│  AgentManager ──fork──► utilityProcess: out/agent/host.mjs  (pi Agent)  │
│               └──fork──► utilityProcess: out/pipeline/host.mjs (蒸馏)    │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
                    src/core（纯 Node，可单测）
            book / chapters / drafts / git(isomorphic-git) / import / fsutil
```

- 主进程不做模型调用：Agent 与知识库各自跑在独立 `utilityProcess`，长循环不卡窗口；
- **数据版本与迁移**：工作区 `workspace.json` 与每本书 `.studio/schema.json` 记录 schemaVersion，升级前自动备份元数据；版本过新时拒绝自动处理并提示升级应用（详见 [docs/schema.md](docs/schema.md)）；
- `src/core` 只依赖 Node，状态全部从文件系统推导，没有独立数据库；
- 路径写入有白名单校验（章节 markdown + 知识文件），Agent 无法越界。

## 测试与 CI

- 216 个单测：core（建书/章节/草稿/Git/导入/删除/导出/章节结构变更/自动存档/全书搜索替换/数据迁移/书籍信息封面/写作统计）、Agent 工具（含 search_story / propose_knowledge）与上下文预算、会话压缩、剧情索引、AI 建议、大纲生成、实体卡/卷摘要、模型注册表、会话成本、知识管线、文风漂移、番茄适配器（本地 stub server）、OpenCode 适配；
- 端到端脚本：`e2e-screenshots` / `e2e-assistant` / `e2e-session` / `e2e-knowledge` / `e2e-import-ui` / `e2e-budget-warn` / `e2e-style-drift` / `e2e-window-close` / `e2e-delete` / `e2e-opencode` / `e2e-export` / `e2e-chapters` / `e2e-autosave` / `e2e-book-search` / `e2e-packaged`；
- CI：GitHub Actions，Windows + Ubuntu 跑 `typecheck` + `lint` + `test:coverage` + 检索质量门槛 + `build`；Windows 额外跑 E2E 冒烟；CodeQL 每周扫描；Dependabot 每周检查依赖。

## 构建与分发

```powershell
npm run release
```

产物在 `release/`：

- `Novel Studio-Setup-<version>-x64.exe`（NSIS 安装包，按用户安装）
- `Novel Studio-Portable-<version>-x64.exe`（便携版）
- `SHA256SUMS.txt` + `RELEASE-<version>.md`

未做代码签名：SmartScreen 可能提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」；
先核对 SHA256。签名目前未启用：SignPath Foundation 需要更高的社区可见度（后续可重新申请），
也可选择 Certum 开源证书等付费方案；启用步骤见 [docs/release.md](docs/release.md)。

## 已知限制

- 只构建 Windows（macOS/Linux 理论上可加，未验证）；
- 在线书源依赖本机番茄下载器，不自带爬虫；
- 单书单 Agent 进程，不支持多书同时对话；
- 一个书只有一个会话，暂不支持会话分支；
- 当前安装包未签名（SignPath Foundation 审核要求较高社区可见度，暂未通过；付费证书方案见 docs/release.md）；自动更新已支持（从 GitHub Releases 检查、SHA256 校验、用户确认安装）。

## 目录结构

```text
src/
  core/       书库、章节、草稿、Git、导入、文件工具
  agent/      Agent 宿主（pi）、工具、提示词、会话状态、模型注册表
  pipeline/   知识库管线（蒸馏/增量/文风）
  main/       Electron 主进程、IPC、Agent/Pipeline Manager、设置存储
  preload/    contextBridge API
  renderer/   React UI（书架/工作台/助手/导入/配置）
  shared/     跨进程类型与纯函数（文风指标、模型目录）
tests/        216 个 vitest 用例
scripts/      构建、模型目录生成、发布、E2E
docs/         设计/架构/管线/发布文档
```

## 参与贡献

- 贡献方式与开发环境：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题请走私密报告：[SECURITY.md](SECURITY.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 文档

- [English README](README.en.md)
- [产品定位](PRODUCT.md)
- [UI 设计规范](docs/ui-design.md)
- [Agent 层设计](docs/agent.md)
- [Git 与版本策略](docs/git-strategy.md)
- [导入](docs/import.md)
- [知识库管线](docs/knowledge-pipeline.md)
- [剧情检索（零 embedding）](docs/story-index.md)
- [性能基准（1000 章大书）](docs/performance.md)
- [检索质量评估（合成语料 + CI 门槛）](docs/retrieval-eval.md)
- [可观测性与崩溃处理](docs/observability.md)
- [从安装到第一本书（使用手册）](docs/getting-started.md)
- [English user guide](docs/getting-started.en.md)
- [构建与分发](docs/release.md)
- [数据版本与迁移](docs/schema.md)

## 许可证

[MIT](LICENSE) © 2025-2026 JeffGuo7 and Novel Studio contributors