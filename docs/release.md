# 构建与分发

> 当前策略：**私有仓库 + 不签名 + 手动分发**。
> 不做自动更新（私有仓库无法匿名拉取 Releases，需要把 token 打包进客户端，不适合）。

## 1. 一条命令出安装包

```powershell
npm run release
```

它依次做：

1. `npm run typecheck`
2. `npm run build`（应用 + Agent/Pipeline 两个 utilityProcess bundle）
3. `electron-builder --win` → NSIS 安装包 + 便携版
4. 计算 SHA256，生成 `release/SHA256SUMS.txt` 和 `release/RELEASE-<version>.md`

产物：

| 文件 | 用途 |
|---|---|
| `Novel Studio-Setup-<version>-x64.exe` | NSIS 安装包（按用户安装、可改目录、创建快捷方式） |
| `Novel Studio-Portable-<version>-x64.exe` | 免安装便携版，双击直接跑 |
| `SHA256SUMS.txt` | 两个 exe 的校验和 |
| `RELEASE-<version>.md` | 发行说明：版本、校验和、安装说明、未签名提示、数据位置 |

## 2. 校验

```powershell
Get-FileHash '.\Novel Studio-Setup-0.11.1-x64.exe' -Algorithm SHA256
```

与 `SHA256SUMS.txt`、发行说明里的值一致即可。

## 3. 未签名的影响

- Windows SmartScreen 可能提示「Windows 已保护你的电脑」→「更多信息」→「仍要运行」；
- 个别企业环境可能直接拦截；
- 不影响应用功能，也不影响数据安全。

消除提示需要代码签名证书。**开源项目有免费渠道**，等有真实用户量再申请即可，代码无需改动：

| 渠道 | 成本 | 备注 |
|---|---|---|
| SignPath Foundation | 免费（OSS） | 项目审核 + 身份验证，CI 集成 |
| Certum Open Source Code Signing | 证书免费（token 可能有成本） | 需身份/项目验证 |
| OV / EV 证书 | $200–700/年 | 个人开源项目不建议 |

拿到证书后：在 CI/本地构建前设置 `CSC_LINK` / `CSC_KEY_PASSWORD`（electron-builder 自动读取），
或改用 SignPath 的 GitHub Action 上传待签产物，业务代码不用动。

## 4. 版本与数据

- 版本号在 `package.json`；打包产物按版本命名。
- 覆盖安装 / 卸载重装**不会**动书库（文档目录 NovelStudio）和配置目录（%APPDATA%\Novel Studio）。
- 「本机配置」弹窗底部显示版本、Electron/Node 版本、书库与配置路径，并提供打开目录的按钮，方便排障。

## 5. 排障

- 主进程未捕获异常不会弹系统错误框，会写入 `%APPDATA%\Novel Studio\main-error.log`（只记录，不中断应用）。
- 回归脚本：`npm run e2e:window` 会在 Agent 推流中关闭窗口，验证主进程不会因窗口销毁而崩溃。

## 6. 如果以后要自动更新

前提：仓库公开（或自建更新服务器）。

1. `npm i electron-updater`
2. electron-builder 增加 `publish: { provider: 'github', owner, repo }`
3. 主进程启动时 `autoUpdater.checkForUpdatesAndNotify()`，设置页加「检查更新」
4. CI 用 `GH_TOKEN` 跑 `electron-builder --publish always`，生成 `latest.yml`

注意：Windows 未签名也能更新，但每次安装仍会被 SmartScreen 拦一次。
