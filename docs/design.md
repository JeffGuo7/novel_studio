# 设计定稿（v0.1）

> 本文锁定三件事：**数据怎么放**、**什么算一个版本**、**应用怎么分层**。
> 后续所有功能都长在这里，改动成本最高，所以先钉死。

## 0. 一句话

一本书 = 一个文件夹 + 一个 Git 仓库（只管正史）；草稿是工作产物，用本地轻量版本库管理。
Electron 客户端，Agent 跑在独立 utilityProcess，Markdown 是唯一真相。

---

## 1. 版本设计的最终决定

### 1.1 决定

| 内容 | 版本方式 | 理由 |
|---|---|---|
| 正史章节、知识文件（世界观/大纲/摘要/文风…） | **Git**，一次归档 = 一个 commit | 可回溯、可分支、可外部工具接管，是"资产" |
| AI 草稿、人工试写稿 | **本地版本库** `.studio/drafts/<key>/vNNN.md` + `meta.json` | 高频、临时、可丢弃，不该污染正史历史 |
| 未保存的编辑 | 不产生版本 | 噪音 |

**保留全部草稿版本，UI 默认只展示最近 20 版，可展开全部；提供"清理旧草稿"手动操作。**
不做自动删除——草稿是纯文本，成本极低，而"删掉的那版恰好写得更好"的代价极高。

### 1.2 为什么草稿不进 Git

考虑过用 `draft/sandbox` 分支（参考项目的做法），但桌面端有硬约束：

- 工作树一次只能检出一个分支，AI 在草稿分支写、作者在正史分支改，**同一份工作目录会互相踩**；
- isomorphic-git 不支持 worktree，做"双工作树"要么自己实现，要么切分支时反复刷新文件（体验差、易丢改动）；
- 草稿提交会让历史出现大量 `draft: ...` 提交，正史时间线被噪音淹没。

所以：**Git 只记录作者认可的历史；草稿用独立轻量版本库。**
`draft/sandbox` 分支模型被取消，复杂度直接消失，安全性不变
（草稿本来就不在 Git 里，自然污染不了正史）。

### 1.3 一次"版本"的定义

自动产生版本的事件：

1. 建书 → v0 基线（`初始化书库`）
2. 确认归档一章 → 一个 commit（章节 + 摘要/状态卡等关联文件**原子打包**）
3. 手动保存知识文件（世界观/大纲/文风）→ 一个 commit
4. 回滚 → **新 commit**（"还原到 xxx"），不改写历史
5. 卷/篇章完成 → 打 tag（后续实现）

不产生版本：打字、自动保存到磁盘、AI 流式输出的中间态。

### 1.4 版本的可读信息

commit 采用结构化前缀，UI 直接解析展示：

```
[归档] 第51章 · 听潮阁来信
[知识] 更新世界观：镇渊司内部派系
[导入] 导入 120 章原文
[还原] 还原到 3f2a1c9 (第49章后)
```

AI 参与时，commit body 记录 `model / promptVersion / tokens`，让"这版是谁写的"可追溯。

---

## 2. 数据布局

```text
<书库根>/<书名>/
├── book.json                 # { schemaVersion, id, title, author, createdAt, updatedAt }
├── chapters/
│   └── 0001_雾夜渡客.md
├── world_model.md            # 世界规则（长期约束）
├── status_card.md            # 当前状态投影
├── summary.md                # 阅读档案（派生，可重建）
├── brainstorm.md             # 灵感池
├── master_outline.md         # 长线读者承诺
├── arc_outline.md            # 篇章单元
├── chapter_outline.md        # 可执行章节卡
├── style_guide.md            # 文风指南
├── style_fingerprint.md      # 文风指纹（派生）
├── error_archive.md          # 负向记忆
├── .studio/
│   ├── drafts/
│   │   └── 0001/
│   │       ├── v001.md
│   │       ├── v002.md
│   │       └── meta.json     # [{version, createdAt, source, model?, note?, parent}]
│   └── project.json          # UI 状态（最后打开的文件、阅读位置）
├── .gitignore                # 忽略 .studio/
└── .git/
```

原则：

- **Markdown 是唯一真相**，SQLite/索引均可删可重建（MVP 先不建索引）；
- 文件名用 `序号_标题.md`，序号 4 位补零，排序即章节序；
- 草稿目录按章节 key（`0001`）存，与章节文件解耦，章节改名不影响草稿。

## 3. 章节状态机

```
(无) ──建草稿──> drafting ──归档──> accepted ──再建草稿──> revising ──归档──> accepted
                    │
                    └──放弃──> (无)        ← 正史零影响
```

状态不落库，**从文件系统推导**：

- `chapters/NNNN_*.md` 存在 → accepted
- `.studio/drafts/NNNN/` 非空 → drafting / revising
- 两者都有 → revising（正在改已发布章节）

推导优于持久化：永远不会出现"状态文件和实际文件不一致"的鬼故事。

## 4. 分层与进程边界

```text
renderer (React)          ← 只经 preload 暴露的 IPC，不碰 fs / 网络 / 密钥
   │ contextBridge
main (Electron)           ← 窗口、菜单、IPC 路由、书库根路径、密钥
   │ utilityProcess
agent host（已实现）      ← pi Agent 循环、模型调用、工具执行（utilityProcess）
   │
core (纯 TS)              ← 书库读写 / GitPort / 草稿版本库 / 归档逻辑（可单测）
```

- `src/core` 不 import electron，**能用 vitest 直接跑**；
- `GitPort` 接口隔离实现（当前 `isomorphic-git`，可换 dugite）；
- Agent 不在 main 里跑（长循环会卡 UI），MVP 先不接，接口留好。

## 5. IPC 协议（v0.1）

| 通道 | 方向 | 作用 |
|---|---|---|
| `workspace:list` | invoke | 列出书库根下所有书 |
| `workspace:create` | invoke | 新建书（建目录 + git init + 模板 + 首个提交） |
| `book:open` | invoke | 打开书，返回快照（章节/知识文件/草稿 key） |
| `book:read` | invoke | 读文件内容（含旧版本 `ref`） |
| `book:save` | invoke | 保存并提交 |
| `drafts:list` | invoke | 列某章节的草稿版本 |
| `drafts:save` | invoke | 保存新草稿版本 |
| `drafts:read` | invoke | 读某版本内容 |
| `drafts:discard` | invoke | 丢弃全部草稿 |
| `drafts:promote` | invoke | 草稿归档为正史章节 |
| `git:history` | invoke | 提交历史 |
| `git:fileHistory` | invoke | 单文件历史 |
| `git:diff` | invoke | 两个版本的差异 |
| `git:rollback` | invoke | 回滚（产生新提交） |

所有写操作都在 core 里做路径校验：只允许 `chapters/*.md` 与白名单知识文件，拒绝 `..`/绝对路径。

## 6. 错误与安全

- 文件写入：先写临时文件再 rename（原子）；
- 并发：单进程内用 per-book 互斥锁，避免两次保存交错；
- 路径：`path.resolve` 后必须仍在 bookDir 内；
- 密钥：.env.local（gitignore）→ main 读取 → 只经子进程 env 传给 Agent Host，渲染层拿不到；
- 崩溃恢复：Git 和 Markdown 都在磁盘上，重启后重新推导状态即可。

## 7. MVP 范围（本次实现）

✅ 书架：列出/新建/打开书
✅ 章节：创建、编辑、保存（提交）
✅ 知识文件：查看、编辑、保存（提交）
✅ 草稿：创建版本、多版对比、恢复旧版、归档成章、丢弃
✅ 历史：提交时间线、单文件历史、预览旧版、回滚
✅ 状态从文件推导，无状态库

✅ Agent 基座：pi agent 在 utilityProcess 里跑，工具只有读 + 写草稿，正史归档仍由人触发

⏳ 不在本次：会话持久化、成本熔断、导入外部小说、摘要管线、多书并行窗口

## 8. 测试策略

- core 层用 **vitest**：建书、保存提交、草稿版本、归档、回滚、路径穿越拦截；
- 每个用例在临时目录跑真实 git 仓库，不做 mock；
- CI 目标：`npm run test` 全绿才可提交。
