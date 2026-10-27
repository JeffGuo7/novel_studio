# 安全策略

## 支持版本

| 版本 | 支持状态 |
|---|---|
| 最新 Release | ✅ 安全修复 |
| 更早版本 | ❌ 建议升级 |

## 报告漏洞

请**不要**在公开 Issue 里报告安全问题。

1. 使用 GitHub 的 [Private vulnerability reporting](https://github.com/JeffGuo7/novel_studio/security/advisories/new)
   提交私密报告（推荐）；
2. 或在仓库的 Security 页面选择「Report a vulnerability」。

请尽量包含：影响版本、复现步骤、影响范围（密钥泄露 / 任意文件读写 / 命令执行 / 供应链）、
以及你建议的修复方向。我们会在 72 小时内确认，并在修复后公开致谢（如果你同意）。

## 密钥与隐私设计（供报告参考）

- API Key 由 Electron `safeStorage` 加密保存在本机配置，不写入书库、不进入 Git；
- 环境变量兜底只用于本机开发，`.env.*` 已被 gitignore；
- 书稿、草稿、会话、检索索引全部在用户本机；
- Agent 运行在独立 utilityProcess，只有「读上下文 / 读章节 / 检索 / 写草稿 / 提知识建议」工具，
  **没有归档、删除、执行任意命令的权限**；
- 知识文件修改必须由作者在 UI 里确认（proposal → diff → accept）。

## 供应链

- 依赖锁在 `package-lock.json`，CI 使用 npm cache；
- Dependabot 监控 npm 与 GitHub Actions 依赖；
- 发布产物附带 `SHA256SUMS.txt`，可在 Release 页面核对。

## 已知边界

- Windows 安装包目前**未做代码签名**，SmartScreen 可能提示"未知发布者"；这是分发成本问题，不是漏洞。
- 模型输出会被当作不可信内容处理：不执行模型生成的命令，只把它写进草稿/建议。
