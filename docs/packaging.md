# 打包与分发

## 结论

**electron-builder + NSIS（per-user 安装）+ asar，Agent Host 放 extraResources。**

| 项 | 值 |
|---|---|
| 安装包 | `release/Novel Studio-<version>-x64.exe`（约 116 MB，Electron 基线决定） |
| 安装方式 | 非一键：可选安装目录、创建桌面/开始菜单快捷方式、按用户安装（不需要管理员） |
| 应用本体 | `resources/app.asar` 约 1.6 MB |
| Agent Host | `resources/agent/host.mjs` 约 5.6 MB（单文件 ESM，内联 pi + isomorphic-git） |
| 运行时依赖 | **没有 node_modules**：所有依赖都打在 bundle 里 |

## 为什么 Agent Host 放在 asar 外

`utilityProcess.fork()` 需要真实的文件路径，**asar 内的文件对子进程不可见**。
所以 `electron-builder.yml` 里：

```yaml
extraResources:
  - from: out/agent
    to: agent
```

主进程启动时按环境选择路径（`src/main/agent-manager.ts`）：

```ts
app.isPackaged
  ? path.join(process.resourcesPath, 'agent', 'host.mjs')
  : path.join(__dirname, '../agent/host.mjs')
```

## 为什么 package.json 没有 dependencies

pi 依赖（约 66 MB 的 SDK 合集）只用在 Agent Host 里，而 Host 已经被 esbuild
打成单文件（5.6 MB，只含实际用到的 provider 实现）。主进程侧 `isomorphic-git`
也被 `externalizeDepsPlugin({ exclude: ['isomorphic-git'] })` 内联进主进程 bundle。

结果：安装包里没有 `node_modules`，也没有 npm 依赖树被漏拷的风险。
代价是每次改依赖都要重新构建（本来也要）。

## 命令

```powershell
npm run dist:dir   # 只出解包目录 release/win-unpacked（调试打包问题最快）
npm run dist       # 出 NSIS 安装包
node scripts/e2e-packaged.mjs   # 直接启动打包产物跑端到端（需要 .env.local 里的 key）
```

`e2e-packaged.mjs` 会验证：asar 里的 preload/renderer 正常、utilityProcess 能执行
`resources/agent/host.mjs`、模型配置生效、工具真的把草稿写进书库。

## 测试钩子

| 环境变量 | 作用 |
|---|---|
| `NOVEL_STUDIO_HOME` | 覆盖书库根目录（默认「文档/NovelStudio」） |
| `NOVEL_STUDIO_USER_DATA` | 覆盖 Electron userData（放 settings.json 与 safeStorage 数据） |

两个都是给自动化测试/多开用的，不影响正常使用。

## 已知限制

- **未签名**：Windows SmartScreen 会提示"未知发布者"。正式分发前需要代码签名证书；
- **无自动更新**：还没接 `electron-updater`（NSIS 已生成 latest.yml，后续可直接接）；
- **只出 Windows x64**：macOS/Linux 目标未配置；
- **图标**：`build/icon.png` 由脚本生成，正式版可换设计稿。
