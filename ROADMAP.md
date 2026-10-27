# Roadmap

目标：把 Novel Studio 做到**可公开、可长期维护、企业级质量**的本地优先 AI 写作工作台。

## 已完成（v0.19.0）

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
- [ ] `propose_knowledge` 工具：AI 只写建议，作者确认后才落盘（log/diff UI）
- [ ] 实体卡：人物 / 地点 / 势力（结构化 Markdown + 检索接入）
- [ ] 卷摘要（每 20–30 章）与增量更新
- [ ] 检索质量评估集：真实书稿（100+ 章）上的 hit@k / 延迟基准

## Phase B：公开仓库就绪

- [ ] LICENSE（MIT）、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY
- [ ] Issue / PR 模板；Issue label 体系
- [ ] 密钥与隐私扫描（已完成 git 历史 sk-/oc_sk_ 扫描；公开前再跑一次全仓扫描）
- [ ] CI 强化：lint、coverage、Linux/Windows 矩阵、E2E 冒烟、依赖审查（Dependabot）
- [ ] Release workflow：tag → 自动构建 + 校验和 + GitHub Release
- [ ] 仓库转 public（历史无密钥、.env.local 已忽略）
- [ ] 自动更新（electron-updater + GitHub Releases，公共仓库后可用）

## Phase C：企业级质量

- [ ] 结构化日志与本地崩溃报告（main-error.log 已有雏形）
- [ ] 数据安全：书库备份/恢复、迁移版本号、损坏检测
- [ ] 性能基准：大书（1000 章）启动 / 索引 / 检索 / Agent 上下文组装
- [ ] 可访问性与键盘操作审计；UI 组件化与设计 token 文档化
- [ ] E2E 回归套件纳入 CI（headless Electron）
- [ ] 代码签名（Windows）与安装体验（首次启动引导、模型配置向导）
- [ ] 文档站/使用手册：从安装到第一本书的完整路径

## Definition of Done（公开前）

- [ ] 新用户从 Release 下载安装 → 配模型 → 建书 → Agent 续写，全程无需文档也能走通
- [ ] 所有测试 / E2E / CI 绿；无高危依赖告警；历史无密钥
- [ ] README 与 docs 与真实功能一致；LICENSE 等社区文件齐备
- [ ] 大书（500+ 章）检索、压缩、预算三条链路均有实测数据
