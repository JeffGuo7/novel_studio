# Roadmap

目标：把 Novel Studio 做到**可公开、可长期维护、企业级质量**的本地优先 AI 写作工作台。

## 当前状态（v0.44.1 · 公开仓库）

- Electron + React + TS 桌面客户端；书库为 Markdown + 每本书嵌套 Git
- 章节 / 知识文件编辑、保存即提交；草稿多版本；历史 diff 与回滚
- 导入：粘贴 / 本地多文件 / 番茄书源适配（本地下载器）
- 知识库管线：总纲 / 世界模型 / 状态卡 / 逐章大纲 / 文风指南 + 指纹；增量更新；改写/删除检测与重建
- Agent（pi 基座）：独立 utilityProcess；只读工具 + 写草稿；无归档/删除权限
- 会话持久化、历史工具轨迹、成本熔断、可配置预算预警
- 模型驱动上下文预算（pi `transformContext`）、对话压缩 `/compact`
- 剧情知识库 v1：MiniSearch + 中文 1/2-gram 全文检索，`search_story` 工具，增量索引
- 打包分发：NSIS + 便携版 + SHA256；CI（Windows + Ubuntu）；GitHub Releases 自动发布

## Phase A：写作能力补全

- [x] 大纲生成向导：一句话创意 → 主线/篇章/世界模型建议 → diff 确认
- [x] `propose_knowledge` 工具：AI 只写建议，作者确认后才落盘（diff UI / 接受 / 拒绝）
- [x] 实体卡：人物 / 地点 / 势力（知识管线生成 + 上下文包注入）
- [x] 卷摘要（知识管线按大纲估算分卷，随上下文包注入）
- [x] 检索质量评估集：120 章合成语料 hit@1/hit@5=10/10，CI 设 100% hit@5 门槛（docs/retrieval-eval.md）

## Phase B：公开仓库就绪

- [x] LICENSE（MIT）、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY
- [x] Issue / PR 模板；Issue label 体系
- [x] 密钥与隐私扫描（已扫描工作树 + 全部 git 历史：无密钥/无绝对路径/无隐私信息）
- [x] CI 强化：oxlint、coverage 门槛、Windows/Ubuntu 矩阵、Dependabot
- [x] Release workflow：tag → 自动构建 + 校验和 + GitHub Release
- [x] 仓库转 public（历史无密钥、.env.local 已忽略；已开启 secret scanning + push protection）
- [x] 公开后加固：CodeQL、分支保护（必需 CI 检查、禁止 force push）
- [x] 自动更新（自定义 GitHub Releases 检查 + SHA256 校验 + 用户确认安装）

## Phase C：企业级质量

- [x] 结构化日志与崩溃处理（JSONL 日志、ErrorBoundary、renderer/utility 退出记录）
- [x] 数据安全：书库 zip 备份/恢复（不覆盖同名书）、损坏检测
- [x] 性能基准：1000 章大书的索引/检索/上下文组装（docs/performance.md）
- [x] 可访问性与键盘操作审计（Esc/焦点环/焦点陷阱/aria-live；Ctrl+S、Enter、Esc 快捷键）
- [x] E2E 回归套件纳入 CI（Windows runner：截图 + 设置/备份/恢复冒烟）
- [x] 安装体验：首启三步引导（配置模型 → 建书 → 开始写）、无模型提示；代码签名：SignPath Foundation 因社区可见度不足暂未通过，保留重新申请 / Certum 付费 / SignPath 付费订阅三条路径
- [x] 使用手册：docs/getting-started.md（安装 → 配置 → 建书 → Agent → 知识库 → 备份/更新）

## Definition of Done（最终验收已达成）

- [x] 新用户从 Release 下载安装 → 配模型 → 建书 → Agent 续写，全程无需文档也能走通（首启三步引导）
- [x] 所有测试 / E2E / CI 绿；无高危依赖告警；历史无密钥
- [x] README 与 docs 与真实功能一致；LICENSE 等社区文件齐备
- [x] 大书（500+ 章）检索、压缩、预算三条链路均有实测数据（docs/performance.md / retrieval-eval.md）


## Phase D：国际化（决策：暂缓全量，先做英文展示；UI 全量 i18n 暂不做）

- [x] 英文 README（README.en.md）+ 仓库英文简介 + 双语 Release 说明
- [x] 明确决策：产品 UI 保持简体中文（中文网文写作场景），暂不做 UI 全量 i18n
- [x] 英文使用手册（docs/getting-started.en.md，按中文 UI 标签对照英文说明）
- [ ] 若出现真实海外作者需求：i18n 基建（react-i18next）+ renderer 英文化 + E2E data-testid 改造（约 3–5 天）
- [ ] Agent 回复语言跟「书的语言」走，不跟 UI 语言走；prompt/知识模板/Git 提交信息保持中文

## Phase E：体验与交付优化（2026-10 起）

按优先级逐步做；"明确不做"的项不在此列（UI 全量 i18n、云同步、多人协作）。

- [x] **导出书稿**：Markdown / TXT / EPUB（本地生成、自动目录、不含草稿）
- [x] **章节管理**：插入 / 上下移动 / 合并 / 拆分 / 重编号（草稿/管线 hash/会话成本/索引同步迁移）
- [x] **自动保存与崩溃恢复**：编辑中 2.5s 防抖写入 `.studio/autosave`，启动/切换时提示恢复，保存后清除（单文件原子写、7 天/50 条上限）
- [x] **全书搜索 / 替换**：Ctrl/Cmd+F，章节+知识文件，字面匹配/区分大小写，按文件/全书替换一次提交
- [x] **模型连接测试 + 应用内代理设置**：一次最小请求（鉴权/网络/模型分类提示）；代理作用于模型请求与更新检查（undici ProxyAgent + Electron session）
- [x] **上下文溢出兜底**：接 pi 的 isContextOverflow，自动折叠早期消息 + 缩小预算 + 重试一次（失败才提示 /compact）
- [x] **检索扩展**：知识文件/实体卡入索引、按章节范围过滤（scope + chapterFrom/chapterTo，v2 索引）
- [x] **一致性检查**：只读审稿模式（章节范围 + 重点关注，四类矛盾分级报告，报告存 .studio/reviews，不改书稿）
- [x] **知识管线产物走 proposal 审批**：首次/增量直写，重建（已有内容）生成 AI 建议并去重，作者接受后才落盘
- [x] **章节元数据缓存**：`.studio/cache/chapters.json`（size+mtime 失效，损坏自愈），1000 章快照 197ms → 67ms
- [x] **自动备份 + 保留策略 + 单本恢复**：默认每 3 天自动备份（userData/backups，保留 5 份，手动备份不清理）；恢复可勾选单本，同名跳过
- [x] **工作区 / .studio schema 迁移框架**：workspace.json + .studio/schema.json 版本号、按序迁移、升级前备份、版本过新拒绝处理


## Phase F：体验优化（P2）

- [x] **书架体验**：搜索（书名/作者/简介）、排序（最近打开/最新创建/书名）、编辑书籍信息、上传封面
- [x] 写作统计（每日新增 / 总字数 / 连续写作 / 每日目标 / 14 天柱状图；.studio/stats.json）
- [x] 成本与套餐内用量展示（OpenCode Go 套餐内显示轮次、不按美元硬停；按量 provider 保留预算）
- [x] Agent 模式（续写 / 润色 / 审稿 / 扩写；审稿只读硬限制；选择持久化）
- [x] renderer 组件测试：jsdom + @testing-library/react（书架搜索/排序/编辑、统计弹窗目标保存）
- 视觉回归：**明确不做像素级对比**（Electron/字体/CI runner 渲染差异大、基线维护成本高）；保留 E2E 截图 artifacts + DOM 断言作为回归手段
- [x] CI 增加性能回归门槛（200 章固定语料，快照/上下文包/索引/检索，Ubuntu verify job）

## Phase G：最终验收（v0.44.1）

- [x] 依赖审计：**生产依赖 npm audit 0 告警，dev 依赖 0 告警**（升级 vitest 5 / vite 8 后复核）
- [x] 全量测试：226 个（含 3 个 jsdom 组件测试）；typecheck / lint / coverage 全绿
- [x] E2E 回归：screenshots / settings / export / chapters / autosave / book-search / bookshelf / stats / billing / modes（CI Windows smoke）
- [x] CI / CodeQL / Release workflow 全绿；CodeQL 0 open；公开仓库 secret scanning 0
- [x] 发布：v0.44.1 由 tag 自动构建并发布（安装包 + 便携版 + SHA256SUMS，匿名可下载）；本机安装同版本并校验版本号
- [x] 文档一致性：README / README.en / docs 与真实功能核对；schema/release/performance/retrieval 文档齐全
- [x] 依赖巡检：vite 7 → 8（electron-vite 6 官方支持）、codeql-action 3 → 4、vitest 5 已落地；TypeScript 7（原生编译器首个大版本）暂缓，待构建链适配后单独升级

### 明确不做（决策与理由）

| 不做 | 理由 |
|---|---|
| 多窗口 / 多书并行 | Electron 单窗口足够；并行书会放大 Agent 进程/预算/索引资源占用，收益低 |
| 会话分支 | 单书单会话 + 草稿版本已覆盖"回到旧版继续写"的主路径；分支会让成本与 UI 复杂化 |
| 像素级视觉回归 | Electron/字体/CI runner 渲染差异大，基线维护成本高；以 DOM 组件测试 + E2E 截图 artifacts 替代 |
| 云同步 / 远程遥测 / 多人协作 | 与"本地优先、无账号、无遥测"的产品承诺冲突 |
| UI 全量多语言 | 目标用户为中文作者；英文 README/Release/手册已覆盖国际展示需求（见 Phase D） |
| 内置爬虫 | 依赖本机番茄下载器，避免版权与合规风险 |
