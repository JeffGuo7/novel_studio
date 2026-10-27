# Novel Studio

<img src="docs/assets/logo.png" width="96" alt="Novel Studio logo" />

[![CI](https://github.com/JeffGuo7/novel_studio/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffGuo7/novel_studio/actions/workflows/ci.yml)

本地优先的 AI 小说创作工作台。**Markdown 是唯一真相，Git 管正史，草稿走独立版本，AI 永远不能自己归档。**

Electron + React + TypeScript + isomorphic-git + [pi agent SDK](https://github.com/earendil-works/pi)。
书稿存在你自己的磁盘上，模型只在你主动发起的那一轮对话里看到它。

![书架](docs/assets/shelf.png)

## 它解决什么问题

用 ChatGPT/Claude 写小说，常见崩点不是"模型写不好"，而是工程问题：

| 问题 | 这个项目的做法 |
|---|---|
| AI 改过的稿子覆盖了原文，想找回 | 每次保存/归档都是 Git 提交，可 diff、可回滚 |
| AI 草稿混进正文 | 草稿存在 `.studio/drafts`，不进 Git；只有作者点「归档」才成为正史 |
| 模型不了解前文设定 | 知识库（世界观/状态卡/总纲/大纲/文风）随上下文注入，超长书自动分块蒸馏 |
| 写着写着不像自己了 | 文风指纹 + 文风漂移检测 |
| token 花费失控 | 会话/单章双预算，超限硬停，重启不能绕过；到阈值预警 |
| 换台机器/重装就丢历史 | 全部文件 + 嵌套 Git，拷走目录即可 |

## 功能

**写作与版本**

- 书架、章节、知识文件（世界观 / 状态卡 / 剧情总纲 / 四层大纲 / 文风 / 错误档案），全部 Markdown
- 章节保存即提交；历史时间线、词级 diff、回滚（回滚也生成新提交，历史不丢）
- 草稿独立多版本，可查看任意版本、以旧版为基线继续写、归档成章、整章丢弃
- 删除：删章节会生成 `[删除]` 提交（历史可找回）；整本书移到书库 `.trash` 回收站，不直接销毁

**导入**

- 粘贴文本、本地多文件批量、番茄书源（适配本机下载器，可选）
- 自动识别 UTF-8 / GB18030，按「第 N 章 / 序章 / 楔子 / Chapter N」切章，一次导入一个提交

**知识库管线**

- 初始化：把章节蒸馏成 剧情总纲 / 世界模型 / 状态卡 / 逐章大纲 / 文风指南 / 文风指纹
- 增量更新：只处理新增章节，状态卡滚动更新
- 失效重建：给每章记内容 hash，旧章节被改写/删除时提示整本重建
- 文风指纹本地统计（句长/段长/对话占比/人称/高频意象），模型只做解读，不编数字

**Agent（pi 基座）**

- 独立 `utilityProcess`；工具只有「读上下文 / 读章节 / **剧情检索** / 写草稿」，**没有归档与删除权限**
- 流式输出、中断、插话；会话持久化，重启后在 UI 里还原对话气泡和工具轨迹
- 成本统计：会话 + 单章双预算，超限封锁输入；阈值预警可配置（默认 80%）
- 上下文预算由模型驱动：按 `contextWindow / maxTokens` 推导，自动裁剪历史与上下文包，面板显示占用
- **对话压缩 /compact**：一键把较早轮次压成结构化摘要（原文仍保留），长对话不爆上下文
- **剧情检索 search_story**：本地全文索引（MiniSearch + 中文 1/2-gram），几百章也能按人物/地名/事件找回旧情节，**不需要 embedding 模型**

**文风漂移**

- 正在看的章节/草稿与文风指纹对比，句长/段长/对话占比偏离阈值时标题旁提示，可查看具体偏差

**分发**

- `npm run release` 一条命令出 NSIS 安装包 + 便携版 + SHA256 校验和 + 发行说明
- 当前未做代码签名（Windows SmartScreen 会提示，按 README 校验后运行）

![工作台](docs/assets/workbench.png)

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
| `npm test` | 单测（83 个，含 faux provider，不烧 token） |
| `npm run typecheck` | 类型检查 |
| `npm run release` | 打包安装包 + 便携版 + 校验和 + 发行说明 |
| `npm run e2e:agent` | 真实模型端到端（需要 key，会花钱） |
| `npm run e2e:window` | 回归：Agent 推流中关窗不能崩 |
| `npm run e2e:budget` / `e2e:drift` | 预算预警 / 文风漂移 UI 端到端（不花钱） |
| `npm run e2e:compact` | 对话压缩端到端（真实摘要调用一次） |
| `npm run e2e:search` | 剧情检索端到端（真实模型会调用 search_story） |

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
- `src/core` 只依赖 Node，状态全部从文件系统推导，没有独立数据库；
- 路径写入有白名单校验（章节 markdown + 知识文件），Agent 无法越界。

## 测试与 CI

- 121 个单测：core（建书/章节/草稿/Git/导入/删除）、Agent 工具（含 search_story）与上下文预算、会话压缩、剧情索引、模型注册表、会话成本、知识管线、文风漂移、番茄适配器（本地 stub server）、OpenCode 适配；
- 端到端脚本：`e2e-screenshots` / `e2e-assistant` / `e2e-session` / `e2e-knowledge` / `e2e-import-ui` / `e2e-budget-warn` / `e2e-style-drift` / `e2e-window-close` / `e2e-delete` / `e2e-opencode` / `e2e-packaged`；
- CI：GitHub Actions，Windows + Ubuntu 双平台跑 `typecheck` + `test` + `build`。

## 构建与分发

```powershell
npm run release
```

产物在 `release/`：

- `Novel Studio-Setup-<version>-x64.exe`（NSIS 安装包，按用户安装）
- `Novel Studio-Portable-<version>-x64.exe`（便携版）
- `SHA256SUMS.txt` + `RELEASE-<version>.md`

未做代码签名：SmartScreen 可能提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」；
先核对 SHA256。以后如有需要，可申请开源免费证书（SignPath Foundation / Certum），细节见
[docs/release.md](docs/release.md)。

## 已知限制

- 只构建 Windows（macOS/Linux 理论上可加，未验证）；
- 在线书源依赖本机番茄下载器，不自带爬虫；
- 单书单 Agent 进程，不支持多书同时对话；
- 一个书只有一个会话，暂不支持会话分支；
- 未签名、无自动更新（私有仓库阶段）。

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
tests/        83 个 vitest 用例
scripts/      构建、模型目录生成、发布、E2E
docs/         设计/架构/管线/发布文档
```

## 文档

- [产品定位](PRODUCT.md)
- [UI 设计规范](docs/ui-design.md)
- [Agent 层设计](docs/agent.md)
- [Git 与版本策略](docs/git-strategy.md)
- [导入](docs/import.md)
- [知识库管线](docs/knowledge-pipeline.md)
- [剧情检索（零 embedding）](docs/story-index.md)
- [构建与分发](docs/release.md)

## 许可证

暂未指定开源许可证（仓库当前为私有）。如需开源，建议 MIT；在加 `LICENSE` 前请保留此说明。
