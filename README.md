# Novel Studio

[![CI](https://github.com/JeffGuo7/novel_studio/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffGuo7/novel_studio/actions/workflows/ci.yml)

本地优先的小说创作工作台。**每一章都有版本，AI 草稿永远污染不了正史。**

Electron + React + TypeScript + isomorphic-git + **pi agent SDK**。
Markdown 是唯一真相，Git 管正史，草稿走独立轻量版本库，Agent 跑在独立 `utilityProcess` 里。

![工作台](docs/assets/workbench.png)

![草稿多版本](docs/assets/draft-versions.png)

![Agent 续写](docs/assets/agent-draft.png)

## 当前状态（v0.2 · Agent 基座已接入）

已实现并跑通（含 Electron 端到端）：

- 书架：建书 / 列出 / 打开
- 章节：新建、编辑、保存（每次保存一个 Git 提交）
- 知识文件：世界观 / 状态卡 / 剧情总纲 / 四层大纲 / 文风 / 错误档案，可编辑提交
- 草稿：多版本保留、任意版本查看、以旧版为基线继续写、归档成章、整章丢弃
- 历史：提交时间线、词级 diff、回滚（生成新提交，历史不丢失）
- 状态从文件系统推导，没有独立状态库
- **Agent（pi 基座）**：读上下文包 → 写草稿版本 → UI 自动跳转；支持中断 / 插话 / 成本统计；
  工具层只有「读」和「写草稿」，**没有归档权限**

未实现（下一步）：

- Agent 会话持久化（重启后记忆丢失）
- 单章/单次成本熔断
- 导入外部小说（番茄 / 本地 txt）
- 摘要与世界观的自动管线
- 打包分发（electron-builder）

## 快速开始

```powershell
npm install
copy .env.example .env.local   # 填入 DEEPSEEK_API_KEY（默认模型 deepseek-flash）
npm run dev                    # 开发模式（热更新）
npm run build                  # 生产构建
npm start                      # 运行构建产物
npm test                       # 单测（core + Agent faux provider，不烧 token）
npm run typecheck              # 类型检查
npm run e2e:agent              # 真实模型端到端（需要 key，会消耗少量 token）
```

书库默认位置：系统「文档」目录下的 `NovelStudio/`；可用环境变量 `NOVEL_STUDIO_HOME` 覆盖。

> ⚠️ 如果你的环境里设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node 进程
> （`app` 为 undefined，但 `process.versions.electron` 仍在，极容易误判）。启动前清掉它。

## 目录结构

```text
novel_studio/
├── src/
│   ├── core/            # 纯 TS 领域层：书库、GitPort、草稿版本（可单测，不依赖 Electron）
│   ├── agent/           # pi 基座：Agent 循环、工具、utilityProcess host
│   ├── main/            # Electron 主进程：窗口 + IPC 路由 + AgentManager
│   ├── preload/         # contextBridge，暴露 window.studio
│   ├── renderer/        # React 工作台（书架 + 三栏）
│   └── shared/          # 主/渲染共用的类型与 IPC 契约
├── tests/               # vitest：真实 git 仓库，不 mock
├── scripts/             # e2e-screenshots.mjs：Playwright 驱动 Electron 跑完整闭环
└── docs/                # 设计定稿、可行性评估、参考项目评审
```

## 文档

- [设计定稿](docs/design.md)：数据布局、版本模型、状态机、IPC 协议
- [Agent 层设计](docs/agent.md)：进程边界、工具权限、事件协议、模型与密钥
- [Git 方案选型](docs/git-strategy.md)：isomorphic-git 实测基准与决策
- [Electron + pi 可行性](docs/feasibility-electron-pi.md)：技术栈验证与 POC 计划
- [参考项目评审](docs/reference-review.md)：值得抄的设计与必须避开的坑

## 已踩过的平台坑（都已在代码里处理）

| 坑 | 现象 | 处理 |
|---|---|---|
| Node 24 + Windows 非 ASCII 路径 | `fs.rmSync` 静默不删，甚至 fail-fast 崩溃 | 用 `unlinkSync`/`rmdirSync` 自实现 `removeDirRecursive` |
| isomorphic-git `statusMatrix` | 同长度、同秒内的修改被判为「未变化」，提交丢失 | 写入方显式给出变更路径 + `force: true` 提交，不靠扫描 |
| `ELECTRON_RUN_AS_NODE=1` | Electron 变成 Node，`app` 为 undefined | 启动前清除该变量（e2e 脚本已处理） |
| ESM 里打包 CJS 依赖 | `Dynamic require of "buffer" is not supported` | esbuild banner 注入 `createRequire`（`scripts/build-agent.mjs`） |

## 设计红线

1. AI 只能写草稿层，正史只接受人工确认的归档；
2. 一次归档 = 一个 commit，多文件原子；
3. 回滚不改写历史，只追加新提交；
4. 草稿不进 Git 历史，书库随时可以用任意 Git 工具接管。
