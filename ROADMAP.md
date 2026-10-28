# Roadmap

目标：把 Novel Studio 做到**可公开、可长期维护、企业级质量**的本地优先 AI 写作工作台。

## 已完成（v0.25.0）

- Electron + React + TS 桌面客户端；书库为 Markdown + 每本书嵌套 Git
- 章节 / 知识文件编辑、保存即提交；草稿多版本；历史 diff 与回滚
- 导入：粘贴 / 本地多文件 / 番茄书源适配（本地下载器）
- 知识库管线：总纲 / 世界模型 / 状态卡 / 逐章大纲 / 文风指南 + 指纹；增量更新；改写/删除检测与重建
- Agent（pi 基座）：独立 utilityProcess；只读工具 + 写草稿；无归档/删除权限
- 会话持久化、历史工具轨迹、成本熔断、可配置预算预警
- 模型驱动上下文预算（pi `transformContext`）、对话压缩 `/compact`
- 剧情知识库 v1：MiniSearch + 中文 1/2-gram 全文检索，`search_story` 工具，增量索引
- 打包分发：NSIS + 便携版 + SHA256；CI（Windows + Ubuntu）；私有 GitHub Release

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
- [x] 安装体验：首启三步引导（配置模型 → 建书 → 开始写）、无模型提示；代码签名仍需证书（SECURITY.md 已说明）
- [x] 使用手册：docs/getting-started.md（安装 → 配置 → 建书 → Agent → 知识库 → 备份/更新）

## Definition of Done（已达成）

- [x] 新用户从 Release 下载安装 → 配模型 → 建书 → Agent 续写，全程无需文档也能走通（首启三步引导）
- [x] 所有测试 / E2E / CI 绿；无高危依赖告警；历史无密钥
- [x] README 与 docs 与真实功能一致；LICENSE 等社区文件齐备
- [x] 大书（500+ 章）检索、压缩、预算三条链路均有实测数据（docs/performance.md / retrieval-eval.md）


## Phase D：国际化（决策：暂缓全量，先做英文展示）

- [x] 英文 README（README.en.md）+ 仓库英文简介 + 双语 Release 说明
- [x] 明确决策：产品 UI 保持简体中文（中文网文写作场景），暂不做 UI 全量 i18n
- [ ] 若出现真实海外作者需求：i18n 基建（react-i18next）+ renderer 英文化 + E2E data-testid 改造（约 3–5 天）
- [ ] Agent 回复语言跟「书的语言」走，不跟 UI 语言走；prompt/知识模板/Git 提交信息保持中文
