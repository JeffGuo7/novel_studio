# 贡献指南

感谢你愿意参与 Novel Studio。这个项目的第一原则是：**作者的数据和正史安全高于一切**。
任何改动都不能破坏「Markdown 是唯一真相、Git 管正史、AI 不能自己归档」这三条。

## 开发环境

- Node.js **24+**（本项目在 Node 24 / Electron 45 上开发）
- Windows 10/11（主要目标平台；Linux 用于 CI 回归）
- 无需数据库、无需 Docker

```powershell
git clone https://github.com/JeffGuo7/novel_studio.git
cd novel_studio
npm install
npm run dev        # Electron + Vite 开发模式
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发模式 |
| `npm run typecheck` | Node + Renderer 类型检查 |
| `npm run lint` | oxlint 静态检查（CI 门禁） |
| `npm test` | 单元测试（137+，默认不联网） |
| `npm run test:coverage` | 覆盖率（逻辑层门槛 70%） |
| `npm run build` | 构建 main / preload / renderer / utilityProcess |
| `npm run release` | 打包 Windows 安装包与便携版（产物在 `release/`） |

E2E 脚本在 `scripts/e2e-*.mjs`，其中真实模型用例需要 `DEEPSEEK_API_KEY`（放在 `.env.local`，**不要提交**）。
不花钱的 UI 回归：`e2e-screenshots` / `e2e-budget-warn` / `e2e-style-drift` / `e2e-proposals` / `e2e-window-close`。

## 提交规范

- 提交信息用中文，类型前缀：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`；
- 一次提交只做一件事，能独立回滚；
- 涉及正史写入、Git、草稿、AI 权限的改动，必须在 PR 描述里说明边界与失败路径。

## PR 要求

1. `npm run typecheck && npm run lint && npm test` 全绿；
2. 新功能附单元测试；涉及 UI 的附截图或 E2E 结果；
3. 不提交任何密钥、书稿、个人路径、`release/` 产物；
4. 改动 AI 工具权限时，必须更新 `docs/agent.md` 的权限边界并说明为什么安全。

## 安全与隐私

- API Key 只通过系统 safeStorage 加密保存在本机配置；`.env.local` 已被 gitignore；
- 书稿、草稿、会话、索引全部在用户本机的书库目录，不上传任何服务器；
- 发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 Issue。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
