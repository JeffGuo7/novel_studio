# 数据版本与迁移

> 目标：格式升级可自动、可诊断、不丢数据；旧版本应用不会悄悄破坏新版本数据。

## 版本文件

| 范围 | 文件 | 内容 |
|---|---|---|
| 工作区 | `<书库>/workspace.json` | `{ schemaVersion, updatedAt }` |
| 单本书 | `<书>/.studio/schema.json` | `{ schemaVersion, updatedAt }` |
| 单本书元信息 | `<书>/book.json` | 已有独立的 `schemaVersion`（v1 起） |

工作区级与 `.studio` 级当前均为 **v1**（初始化版本）。

## 升级流程（应用启动时）

1. 读取版本文件；不存在/损坏按 v0 处理；
2. 版本比应用新 → **拒绝迁移**，记录日志并弹窗提示「请升级 Novel Studio」，不修改任何数据；
3. 有可用迁移 → 先把会话/管线状态/自动存档/缓存/建议等元数据复制到：
   - 工作区：`<书库>/.schema-backup/workspace-v{old}-to-v{new}-{时间}/`
   - 单本书：`<书>/.studio/.schema-backup/studio-v{old}-to-v{new}-{时间}/`
4. 按版本号顺序执行迁移链；迁移抛错时版本不推进、备份保留，应用继续启动并记录错误；
5. 成功后写入新版本号；每个范围最多保留 2 份迁移备份。

## 迁移链

- `WORKSPACE_MIGRATIONS` / `STUDIO_MIGRATIONS` 在 `src/core/workspace-schema.ts` 中按目标版本追加；
- v1 为初始化版本，不改动数据；
- 新版本迁移必须幂等：重复执行结果一致，且不依赖外部网络。

## 边界

- 迁移只处理元数据（`.studio`）与版本文件，**不触碰章节正文**；
- 迁移失败不会删除原文件；备份目录可人工取回；
- 「版本过新」是硬错误：不要用旧版应用继续写新格式数据。
