# UI 设计规范（v0.5 · 明亮纸感）

> 来源：`ui-ux-pro-max` 设计系统检索（product: writing editor, warm literary, light）
> + `impeccable` 的 Operate 模式约束：工具型界面优先可扫描性、一致性和真实使用场景。

## 1. 视觉方向

**暖纸 + 墨色 + 琥珀。** 不是通用 SaaS 的白底蓝按钮，也不是暗色编辑器；
这是一个"长期写作的桌面书房"：纸感底色降低长时间注视的对比疲劳，琥珀只用于强调动作，
衬线字体承担标题与正文，界面文字保持无衬线以保证扫描效率。

- 光感：浅暖纸底（`#f7f2e8`），卡片纯白偏暖（`#fffdf8`），阴影极轻。
- 层级靠**底色差 + 细边框 + 极浅阴影**，不靠重阴影或色块。
- 禁止：渐变文字、装饰性玻璃拟态、彩色左边框、emoji 当图标。

## 2. 颜色 Token

| 角色 | 值 | 用途 |
|---|---|---|
| `--paper` | `#f7f2e8` | 应用底色 |
| `--surface` | `#fffdf8` | 卡片 / 阅读纸面 / 输入框 |
| `--surface-2` | `#fbf7ee` | 侧栏、次级面板 |
| `--surface-3` | `#f2ece0` | hover、标签底 |
| `--ink` | `#1c1917` | 正文主色（暖近黑） |
| `--ink-soft` | `#44403c` | 次级正文 |
| `--muted` | `#7a7266` | 辅助信息 |
| `--muted-2` | `#9c9284` | 占位、极弱信息 |
| `--border` | `#e6ddcd` | 常规分隔 |
| `--accent` | `#b45309` | 主按钮、选中态、链接 |
| `--accent-soft` | `#fdf0d9` | 选中底、用户气泡 |
| `--success` | `#15803d` | 归档 / 工具成功 |
| `--danger` | `#b91c1c` | 错误、丢弃、预算超限 |

正文与占位文字对比度均 ≥ 4.5:1（暖纸底上的 `--muted-2` 只用于 11–12px 的辅助标签）。

## 3. 字体

| 用途 | 字体 |
|---|---|
| 界面正文 / 控件 | `Inter Variable` → 系统中文字体（微软雅黑 UI / PingFang） |
| 标题 / 品牌 / 数字标题 | `Cormorant Garamond` → 宋体（Songti SC / SimSun） |
| 小说阅读与编辑器 | `Cormorant Garamond` → 宋体 / Noto Serif SC |
| 代码 / 章节号 / 时间 | Cascadia Code / Consolas |

字体自托管在 `@fontsource` 包里，随构建产物打包，**不依赖网络加载**。
中文回退到系统宋体（Windows 自带），保证离线可用。

排版：界面 13–14px / 1.5；阅读面 18px / 2.0，最大行宽 760px；标题层级 56 → 34 → 25 → 19。

## 4. 图标

统一使用 **lucide-react（SVG 组件）**，线性风格、1.5–2px 描边、14–16px。

| 场景 | 图标 |
|---|---|
| 返回书架 | `ArrowLeft` |
| 保存 / 归档 | `Save` |
| 新建章节 | `FilePlus` |
| 导入文本 | `FileInput` |
| 配置 | `Settings` |
| 章节 / 知识文件 | `BookOpen` / `FileText` |
| 面板 | `PenLine`（草稿）/ `History`（历史）/ `Bot`（助手） |
| Agent 动作 | `Send` / `Square`（停止）/ `RotateCcw`（重置） |
| 状态 | `Check` / `X` / `Loader2`（旋转） |
| 提示 | `CheckCircle2` / `AlertCircle` |

**硬规则：不使用 emoji 或 Unicode 符号充当图标**（`←`、`✓`、`⚙` 已全部替换）。

## 5. 组件规则

- 按钮：6px 圆角、`inline-flex`、图标与文字 gap 6px、hover 160ms；主操作实心琥珀，次操作描边。
- 卡片：10px 圆角 + 1px 边框 + `--shadow-xs`；hover 抬升 2px + `--shadow-sm`。
- 阅读面：白纸卡片、56px 内边距、行高 2，像一页纸而不是表格。
- 弹层：遮罩 `rgba(41,37,33,.28)` + 3px 背景模糊，面板 16px 圆角 + `--shadow-md`。
- 焦点：2px 琥珀 outline + 2px offset，键盘可达。
- 滚动条：10px、暖灰、content-box 内缩，不用系统默认亮色滚动条。
- 选中文字：琥珀浅底。
- 动效：150–220ms ease-out；仅在弹层/提示出现与 hover 使用；`prefers-reduced-motion` 全局降级。

## 6. 可访问性清单

- [x] 正文对比度 ≥ 4.5:1
- [x] 所有交互元素有 hover / focus-visible 状态
- [x] 图标按钮带 `aria-label`（弹层关闭按钮）
- [x] 键盘可用：按钮/输入/标签页均为原生元素
- [x] 动效可降级
- [x] 无 emoji 图标
- [x] 离线可用（字体自托管）

## 7. 实现位置

- Token 与全部样式：`src/renderer/src/styles.css`（单文件变量体系，无 UI 框架）
- 字体引入：`src/renderer/src/main.tsx`（`@fontsource` 静态导入）
- 图标：各组件从 `lucide-react` 按需导入
