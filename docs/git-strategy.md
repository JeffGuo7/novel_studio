# Git 方案选型（实测）

> 结论：**MVP 用 `isomorphic-git`（纯 JS），外面套一层 `GitPort` 接口，`dugite` 作为后续兜底。**
> 依据不是猜的——两个方案在相同数据规模上跑过基准，且互相读过对方的仓库。

## 1. 我们到底需要 Git 做什么

先把需求钉死，避免为了"完整 Git 能力"付不必要的代价：

| 能力 | 用在哪 | 必需 |
|---|---|---|
| `init` | 新建一本书的仓库 | ✅ |
| `add` + `commit` | 归档章节、快照世界观/大纲 | ✅ |
| `branch` / `checkout` | `draft/sandbox` 草稿层 vs `main` 正史层 | ✅ |
| `log` | 历史时间线、章节演进 | ✅ |
| 读取历史版本文件 | 对比、回退预览 | ✅ |
| `diff` | 审核台看"AI 改了什么" | ✅（但要词级 diff） |
| `merge` | 草稿确认后并入正史 | ✅（只需 fast-forward） |
| 强制回退 | 剧情回滚 | ✅ |
| 中文文件名/内容 | 全书默认 | ✅ |
| `rebase` / `stash` / `blame` / 子模块 / hooks | 用不到 | ❌ |

注意最后那条：很多"Git 方案对比"会拿 rebase、子模块、LFS 说事，但**小说创作工作台不需要这些**。
按这个清单选，可选项就少了一半。

## 2. 候选方案

| 方案 | 形态 | 是否需要外部 git | 体积 |
|---|---|---|---|
| **isomorphic-git** 1.44.4 | 纯 JS 重实现 | ❌ 不需要 | 打包后 **0.58 MB** |
| **simple-git** 4.0.2 | 包装命令行 `git` | ✅ 需要用户装/我们打包 | 打包 **0.10 MB** + git 二进制 |
| **dugite** 3.3.1 | GitHub Desktop 的方案：下载并管理便携版 git | ✅ 随包下载 | 包本身 69 KB + **约 40 MB git 二进制** |
| **nodegit** 0.27.0 | libgit2 原生绑定 | ❌ | 需要针对 Electron ABI 重新编译，**排除** |
| `@napi-rs/simple-git` 1.2.0 | Rust 绑定（napi） | ❌ | 原生模块，同样要重建，备选但不必要 |

## 3. 实测基准

数据规模：**200 个章节文件**（中文文件名 + 中文正文，每章约 3 KB）+ 5 个知识文件。
机器：Windows / Node 24 / 系统 Git 2.55。

| 操作 | simple-git（git.exe） | isomorphic-git | 说明 |
|---|---|---|---|
| init | 133 ms | **7 ms** | |
| 首次提交 205 个文件 | 2141 ms | **1060 ms** | |
| **50 次提交** | **10651 ms** | **765 ms** | 差 **14 倍** |
| status | 76 ms | 25 ms | |
| log(50) | 69 ms | 19 ms | |
| 建分支+提交+切回 | 414 ms | 49 ms | |
| diff | 70 ms | —（无内置 API） | 见 4.1 |
| 读历史版本文件 | 62 ms | 10 ms | |

isomorphic-git 规模测试（同一仓库累积到 **501 次提交**）：

| 操作 | 耗时 |
|---|---|
| 450 次追加提交 | 6005 ms（约 **13 ms/次**，线性增长） |
| log(depth=500) | 199 ms |
| statusMatrix（205 文件 / 501 提交后） | 36 ms |
| 读取 HEAD~400 的文件 | 156 ms |
| 分支 + 提交 + 切回 + merge | 294 ms |
| 强制回退到 HEAD~2 | 71 ms |
| `.git` 体积 | 2.9 MB |

**为什么 simple-git 慢 14 倍**：不是 git 本身慢，是每次操作都要
`spawn` 一个 `git.exe` 进程，Windows 上单次约 100 ms。50 次提交 = 100 个进程。
如果采用"每次归档打包成一个 commit"（我们本来就该这样），这个差距在实际使用中会小很多，
但导入 200 章、批量重建摘要这类批量操作仍会明显卡顿。

## 4. isomorphic-git 的四个真实短板（都能处理）

### 4.1 没有 `diff` API

导出列表里没有 `diff`（只有 `walk` / `statusMatrix` / `readBlob` / `readTree`）。
**影响**：不能一行拿到 unified diff。

**对策**：审核台本来就需要**词级 diff**（中文按字/词高亮），unified diff 不够用。
所以无论如何都要引入 JS diff 库（如 `diff` / `diff-match-patch`）自己算。
实现路径：`readTree(A)` + `readTree(B)` → 找出 oid 变化的文件 → `readBlob` 两版 → 本地 diff。

### 4.2 没有 `gc`（但可以自己压）

它有 `packObjects` / `indexPack`，即“能读写 packfile”，只是不自动 gc。
长期使用 loose object 会累积（实测 500 次提交约 2.9 MB，可接受）。

**对策**：每 N 次提交或应用空闲时调用 `packObjects` 重新打包；
或者检测到系统里有 `git` 时，可选地跑一次 `git gc`（只作为优化，不作为依赖）。

### 4.3 合并冲突处理弱

`merge` 支持 fast-forward 与三方合并，但冲突时没有 shell 那样的交互式解决流程
（只有 `abortMerge` 和底层 index 操作）。

**对策**：**从设计上避免冲突**——
`draft/sandbox` 只由 AI 追加写入、`main` 只由"人工确认归档"写入，
两边几乎不会改同一文件；归档时只允许 fast-forward，失败就提示"正史已被修改，请重新生成草稿"。
这比事后做冲突解决 UI 简单得多，也更符合创作场景。

### 4.4 生态与边界情况

- 不支持 submodule / worktree / hooks / rebase —— 我们不需要；
- 是重新实现，极端边界（超大文件、奇怪编码、外部工具重新打包过的仓库）不如真 git 稳。

**对策**：`GitPort` 抽象 + `ExternalGitAdapter`（dugite）兜底。只要接口设计好，换实现是局部改动。

## 5. 互操作验证（关键，决定敢不敢用）

一个"纯 JS 替代品"最大的风险是：**生成的仓库是不是标准 Git、能不能读别人的仓库**。实测：

| 方向 | 结果 |
|---|---|
| isomorphic-git 读系统 git 创建的仓库 | ✅ 读到 5 条提交、205 个文件、2 个分支，**中文文件名正常** |
| 系统 git 读 isomorphic-git 创建的仓库 | ✅ `git log` 正常，`git fsck` 通过（仅一条 force-checkout 留下的 dangling commit，属正常现象） |

结论：`.git` 是标准格式，用户随时可以用 GitHub Desktop / GitKraken / 命令行接管。
这一条对"数据不被应用锁死"这个原则非常重要。

## 6. 决策

```text
GitPort（稳定接口）
├── IsoGitAdapter       ← MVP 默认，零外部依赖
└── ExternalGitAdapter  ← 兜底：dugite（打包便携 git）或 simple-git（复用系统 git）
```

**为什么不是 simple-git + dugite 直接上**：
它多了约 40 MB 安装包、Windows 编码/路径坑（参考项目就在这栽过）、以及每次操作的进程开销；
换来的是"完整 git"——但我们的能力清单不需要完整 git。

**为什么不是 nodegit**：原生模块要针对 Electron ABI 重编译，打包和升级成本高，收益不成正比。

## 7. 配套设计（比选型更影响体验）

### 7.1 分支模型

```text
main                    正史：只接受"人工确认归档"的提交
└── draft/sandbox       草稿：AI 写入的唯一目标分支（可丢弃、可重置）
```

- AI 只能在 `draft/sandbox` 上写；
- 作者点"确认归档" → fast-forward 到 `main` → 删除/重置草稿分支；
- 作者点"放弃" → 直接重置草稿分支，正史零影响。

### 7.2 提交粒度

- **一次归档 = 一个 commit**（章节文件 + 摘要 + 状态卡 + 大纲变更打包），原子且可整体回退；
- 信息格式：`归档 第 51 章 · 听潮阁来信`；
- 卷/篇章完成时打 tag：`arc-03`，方便回看里程碑。

### 7.3 回滚策略

不改写历史。回滚 = `checkout` 到目标提交 + 在 `main` 上创建一个新提交表示"回到此处"，
历史仍然完整可追溯。这样用户不会"回滚后找不到自己删掉的东西"。

### 7.4 自动提交与手动提交

- 自动：归档、重建摘要、确认草稿；
- 手动：用户在 Git 面板里写 commit message 快照当前状态（高级功能，MVP 可后置）。

## 8. GitPort 接口草案

```ts
export interface GitPort {
  init(dir: string): Promise<void>
  status(dir: string): Promise<FileChange[]>

  commitFiles(dir: string, paths: string[], message: string): Promise<CommitId>
  log(dir: string, opts?: { depth?: number; ref?: string }): Promise<CommitInfo[]>
  readFileAt(dir: string, ref: string, path: string): Promise<string>
  diff(dir: string, from: string, to: string): Promise<FileDiff[]>

  createBranch(dir: string, name: string, from?: string, force?: boolean): Promise<void>
  checkout(dir: string, ref: string, opts?: { force?: boolean }): Promise<void>
  currentBranch(dir: string): Promise<string>
  merge(dir: string, ours: string, theirs: string): Promise<MergeResult>

  compact(dir: string): Promise<void>   // 可选：packObjects / 调用系统 git gc
}
```

`FileDiff` 里的行/词级差异由 core 层的 diff 库生成，GitPort 只负责"取两版内容"。

## 9. 结论与下一步

1. 选 **isomorphic-git**，理由是零安装、快、UTF-8 无坑、与标准 Git 互操作已验证；
2. 用 `GitPort` 隔离，避免被单一实现锁死；
3. 冲突靠**分支职责分离**避免，而不是靠合并算法；
4. 剩一个待验证项：**超大仓库（>5000 提交 / >2000 文件）时 `log` 与 `status` 的表现**，
   建议在 MVP 后期用真实的长篇（200 万字、300 章）做一次压力测试。

## 附：参考项目的做法（对照）

参考项目用 **GitPython**（Python 封装 `git` 命令行）——等价于我们的 `simple-git` 路线：

- 优点：完整 Git 能力，行为与命令行一致；
- 缺点：必须装 Git、Windows 编码坑（GBK 解码崩溃我们实测遇到过）、每次操作起进程；
- 它作为 Web 服务跑在服务器上，这个代价可以接受；**我们是桌面客户端，代价直接落在用户机器上**，
  所以选择相反的路线更合理。
