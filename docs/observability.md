# 可观测性与崩溃处理

> 目标：出问题时有本地证据可查，且**绝不**把书稿/密钥上传到任何服务器。

## 日志

- 位置：`%APPDATA%\Novel Studio\logs\main-YYYY-MM-DD.log`（设置 →「打开日志目录」）；
- 格式：JSON Lines，一行一条：

```json
{"ts":"2026-10-28T02:31:00.000Z","level":"info","scope":"app","message":"应用启动","data":{"version":"0.23.0"}}
```

- 级别：`debug` / `info` / `warn` / `error`；`scope` 支持子作用域（如 `app:agent`）；
- 记录内容：应用启动与版本、渲染进程崩溃、utilityProcess 退出、更新检查失败、
  备份/恢复异常、渲染层未捕获错误（节流 2 秒）；
- **不会记录**：API Key、书稿正文、会话内容；
- 按天滚动，不会无限增长；写入失败静默，不影响主流程。

## 崩溃处理

| 层级 | 机制 |
|---|---|
| 主进程未捕获异常 | 写结构化日志（不弹系统框），继续运行 |
| 渲染进程崩溃 | 记录 `render-process-gone` 原因，弹窗让用户「重新加载 / 退出」 |
| utilityProcess 退出 | 记录 type/reason/exitCode，下次操作自动重启对应 host |
| React 组件崩溃 | `ErrorBoundary` 兜底页：错误摘要 + 重新加载 + 打开日志目录 |
| 窗口级未捕获错误 | `window.error` / `unhandledrejection` 上报主进程日志 |

## 排障流程

1. 设置 →「打开日志目录」，找到当天的 `main-*.log`；
2. 搜 `"level":"error"` 或时间点附近的 `warn`；
3. 反馈 Issue 时附上相关日志片段，并**先删掉任何包含本地路径/书名等个人信息的部分**；
4. 书稿本身不受影响：所有书稿都在书库目录的 Markdown + 嵌套 Git 里。

## 隐私边界

- 日志只落本地磁盘，应用没有任何自动上传逻辑；
- GitHub Issue 是手动行为，由用户决定贴什么；
- 备份 zip 同样只在本地，不上传。
