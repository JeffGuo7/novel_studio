# 剧情知识库（本地全文检索，零额外模型）

> 目标：几百章的书，Agent 也能"记得"早期情节；**不引入 embedding 模型**，用户只需要配一个对话模型。

## 1. 为什么不用向量检索

向量检索需要 embedding 模型 + 向量库：用户已经要配对话模型，再要求配 embedding 是双重门槛；
本地索引也可能牵扯原生模块/打包问题。所以 v1 选择**纯本地全文检索**：

- 索引器：MiniSearch（纯 JS，MIT，无原生依赖）；
- 中文切分：**1-gram + 2-gram**（不依赖分词器）；
- 排序：BM25（IDF 让"阿九+听潮阁"这类稀有组合排到最前）；
- 全流程离线，索引存在书库 `.studio/index/`（已被书库 `.gitignore` 忽略）。

## 2. 选型依据（实测）

GitHub 调研：
- [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex)（39.7k★，MIT）：vectorless、树索引 + LLM 推理，
  说明"不用向量也能做长文档检索"；
- [lucaong/minisearch](https://github.com/lucaong/minisearch)（6.2k★，MIT）：纯 JS 全文检索，支持自定义 tokenizer；
- [nextapps-de/flexsearch](https://github.com/nextapps-de/flexsearch)（13.8k★，Apache-2.0）：内置 CJK，
  但实测中文多词/自然语言查询召回不足；
- A-RAG 等 agentic RAG 方案依赖 embedding 建索引 → 不符合"零额外模型"约束。

本地基准（300 章 / 80.2 万字 / 2403 块；另测 1000 章 / 267 万字）：

| 方案 | hit@1 | hit@5 | 查询耗时 | 索引体积 |
|---|---|---|---|---|
| **MiniSearch + 1/2-gram** | **9/9** | **9/9** | ~3.9ms | 5.3MB（300 章）/ 18.4MB（1000 章） |
| MiniSearch + 2-gram | 8/9 | 8/9 | ~1.5ms | 3.0MB |
| MiniSearch + 3-gram | 7/9 | 8/9 | ~0.8ms | — |
| Intl.Segmenter 分词 | 7/9 | 7/9 | ~1.7ms | — |
| FlexSearch(CJK) | 5/9 | 5/9 | ~0.1ms | 1.2MB |
| 纯子串扫描 | 5/9 | 5/9 | ~0.5ms | 0 |

1000 章实测：首次建索引 2.7s，修改一章增量更新 **3.9ms**，查询毫秒级。
（脚本在 `.tmp/search-bench/`，语料为确定性生成的中文小说。）

## 3. 实现

| 文件 | 作用 |
|---|---|
| `src/agent/story-index.ts` | 切块、1/2-gram tokenizer、索引构建/增量同步/持久化、检索 |
| `src/agent/tools.ts` | Agent 工具 `search_story(query, limit)` |
| `src/agent/tool-summary.ts` | 工具轨迹文案（实时与历史一致） |

- **切块**：每 800 字左右一块，优先在句末断开，块间保留 120 字重叠；
- **字段**：`chapterTitle` 权重 3、正文权重 1；存 `preview`（320 字）+ `text` 用于二次过滤；
- **二次过滤**：查询里的中文二元组必须出现在命中块中，避免 1-gram 把单字巧合当相关结果；
- **增量同步**：不挂全局钩子；检索前直接读章节内容算 hash（避免 stat/read 竞态），只重建变化的章节；
  删除的章节会 discard 旧块；也可通过 `rebuildStoryIndex()` 强制重建；
- **持久化**：`.studio/index/search-index.json`（MiniSearch 序列化）+ `meta.json`（章节 hash）；
- **隐私**：索引只存在本地书库，不上传、不进 Git。

## 4. Agent 如何使用

- 系统提示要求：回忆旧情节时先 `search_story`，命中后再 `read_chapter` 读原文；
- 工具返回：命中片段 + 章节定位 + 相关度，并提示"需要完整上下文用 read_chapter"；
- 结果条数默认 5（最多 8），直接进对话上下文，占输入预算很小。

## 5. 限制与后续

- 纯词汇检索对**同义改写**有天花板（"救下" vs "救了"）；1-gram 兜底 + Agent 自己换关键词可以缓解；
- 下一步：实体卡（人物/地点/势力）、卷摘要、PageIndex 式"章节目录 + LLM 推理导航"；
- embedding 检索保留为可选增强，但**不作为默认依赖**。
