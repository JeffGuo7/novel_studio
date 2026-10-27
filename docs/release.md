# 构建、发布与更新

> 当前策略：**公开仓库 + tag 触发 CI 全自动发布 + 自研更新器 + 可选代码签名**。
> 未配置证书时安装包不签名（SmartScreen 会提示"未知发布者"），功能与数据安全不受影响。

## 1. 本地出安装包

```powershell
npm run release
```

依次执行：类型检查 → `npm run build`（应用 + Agent/Pipeline utilityProcess bundle）→
`electron-builder --win --publish never` → SHA256 校验和 + 发行说明。

产物（`release/`，已 gitignore）：

| 文件 | 用途 |
|---|---|
| `Novel Studio-Setup-<version>-x64.exe` | NSIS 安装包（按用户安装、可改目录、创建快捷方式） |
| `Novel Studio-Portable-<version>-x64.exe` | 免安装便携版 |
| `SHA256SUMS.txt` | 两个 exe 的校验和 |
| `RELEASE-<version>.md` | 发行说明（版本、校验和、安装说明、数据位置） |

## 2. 正式发布（推荐路径）

```powershell
# 1. 改版本号（package.json）
# 2. 提交并打 tag
git tag -a v0.25.0 -m "Novel Studio 0.25.0"
git push origin main v0.25.0
```

推 tag 后 `.github/workflows/release.yml` 会自动：

1. `npm run typecheck` + `lint` + `test:coverage`；
2. `node scripts/release.mjs --skip-check` 在 Windows runner 构建；
3. 用 `softprops/action-gh-release` 创建 Release 并上传 exe / 校验和 / 说明。

**不要**手动运行 `electron-builder --publish always`：`release.mjs` 已加 `--publish never`，
避免 electron-builder 在 tag 上隐式发布（曾导致 CI 因缺少 `GH_TOKEN` 失败）。

## 3. 代码签名（可选，企业分发建议）

未签名的影响：SmartScreen 首次运行提示"未知发布者"，个别企业环境可能拦截；不影响功能与数据。

签名就绪：CI 在 Package 步骤读取以下 secrets，有值 electron-builder 自动签名，无值跳过：

| Secret | 说明 |
|---|---|
| `CSC_LINK` | 证书文件路径或 base64（.pfx） |
| `CSC_KEY_PASSWORD` | 证书密码 |

免费/低成本渠道：

| 渠道 | 成本 | 备注 |
|---|---|---|
| SignPath Foundation | 免费（OSS） | 项目审核 + 身份验证，CI 集成 |
| Certum Open Source Code Signing | 证书免费（token 可能有成本） | 需身份/项目验证 |
| OV / EV 证书 | $200–700/年 | 个人开源项目不建议 |

> 当前仓库**没有**配置证书，因此 Release 产物未签名；这是唯一需要外部资源才能完成的企业级项。

## 4. 自动更新机制

应用内的更新器是**自研、无 electron-updater 依赖**：

1. `GET https://api.github.com/repos/JeffGuo7/novel_studio/releases/latest`；
2. 语义化比较版本（`v` 前缀、预发布处理）；
3. 选择 Setup 资产，下载到临时目录；
4. 拉取 `SHA256SUMS.txt` 校验安装包（资产名空格/点差异已归一化）；
5. 用户点「重启并安装」才打开安装器并退出，不做静默安装。

- 启动 8 秒后静默检查一次；配置页有「检查更新 / 下载 / 重启安装 / 打开发布页」；
- 演练：`npm run doctor:update -- --download`（真实下载并校验 SHA256，不安装）。

## 5. 版本与数据

- 版本号在 `package.json`；覆盖安装/卸载重装不会动书库（文档目录 NovelStudio）与配置目录（%APPDATA%\Novel Studio）；
- 数据备份/恢复见设置页「数据安全」；日志在 `%APPDATA%\Novel Studio\logs`。

## 6. 排障

- 结构化日志：`logs/main-YYYY-MM-DD.log`（JSONL，按天滚动，只存本地）；
- 回归脚本：
  - `npm run e2e:smoke`：截图 + 设置/备份/恢复；
  - `npm run e2e:window`：Agent 推流中关窗不崩；
  - `npm run e2e:delete` / `e2e:compact` / `e2e:search` / `e2e:outline` 等按需跑。
