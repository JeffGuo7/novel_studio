# From install to your first book (user guide)

> Goal: get from a fresh install to writing, with an Agent draft, archive, and backup —
> in about 10 minutes, without reading the source code.
>
> **[简体中文](getting-started.md) · English**
>
> **Note:** the application UI is currently Simplified Chinese only. This guide shows the Chinese
> button labels together with their English meaning, e.g. **Settings (本机配置)**, so you can follow
> the UI even if you don't read Chinese. Model prompts, knowledge files and the Agent's replies are
> Chinese by design, because the product targets Chinese-language fiction.

## 1. Install

1. Open [Releases](https://github.com/JeffGuo7/novel_studio/releases) and download the latest
   `Novel Studio-Setup-<version>-x64.exe`;
2. Run the installer. The build is **not code-signed yet** (a SignPath Foundation OSS application is
   under review), so Windows SmartScreen may show "unknown publisher" — this is expected. Verify the
   SHA256 checksum published in `SHA256SUMS.txt` if you want to be sure the download is intact;
3. On first launch you'll see an empty bookshelf.

> The `Portable` build needs no installation — just double-click it. Data defaults to
> `Documents\NovelStudio`.

## 2. Configure a model (required)

Click **Settings (本机配置)** in the top-right corner:

1. Choose a provider (DeepSeek / OpenCode / OpenAI / Anthropic / a custom OpenAI-compatible endpoint);
2. Choose a model — `deepseek-flash` is the recommended default (cheap and good enough);
3. Paste your API key and save. Keys are encrypted with the OS safeStorage and stay on this machine;
   they are never written into books or Git;
4. Click **Test connection (测试连接)**: a minimal request tells you whether it is an auth, network or model problem;
5. If your network needs a proxy, fill in **Network proxy (网络代理)** (e.g. `http://127.0.0.1:7890`); it applies to both model requests and update checks.

Keep the default budgets: $0.50 per book session / $0.20 per chapter. You get a warning at 80%, and
input is hard-blocked when the budget is exhausted.

## 3. Create a book / import an existing one

- **Create**: type a title on the bookshelf → **Create book (新建书)**;
- **Import**:
  - **Import (导入)** in the top bar → paste text, or pick local `.txt` / `.md` files (multi-select supported);
  - the Fanqie (番茄) book source is also supported (it needs a local Fanqie downloader; the app will guide you);
- Import splits by chapter headings such as `第 X 章`, writes one Markdown file per chapter, and creates
  a single Git commit.

## 4. Write your first chapter

> While editing, changes are autosaved to `.studio/autosave` 2.5 seconds after you stop typing.
> If the app crashes or loses power, reopening it shows an **unsaved autosave** banner — click
> **Restore (恢复)** to recover it; a successful save clears the autosave.

Two ways, and you can mix them:

**Write it yourself**: open a chapter → **Edit (编辑)** → write → save (`Ctrl/Cmd + S`). Every save is a
Git commit.

**Let the Agent draft it**:
1. Open the chapter you want to write (or click **New chapter (新建章节)**);
2. Switch the right panel to **Assistant (助手)** and say: "续写这一章，2000 字左右" (continue this chapter,
   about 2,000 characters);
3. The Agent first calls `read_context` to read the world model / outlines / previous chapter, then
   `search_story` to recall earlier plot, and finally `write_draft` to save into a **draft**;
4. Open the **Drafts (草稿)** tab to inspect versions. When you're happy, click **Archive as chapter X
   (归档为第 X 章)** — archiving is always your click.

> The Agent has no archive or delete permission, and it cannot edit knowledge files directly — it can
> only propose changes (see section 6).

## 5. Initialize the knowledge base (recommended)

After you have at least 3 chapters, click **Initialize knowledge (初始化知识)** in the top bar:

- It distills the book into: plot synopsis, world model, status card, per-chapter outline, style guide
  and style fingerprint, plus character / location / faction cards and volume summaries;
- The first run is a full build; later runs are incremental. If an archived chapter is rewritten or
  deleted, the app offers **Rebuild knowledge (重建知识)**;
- **A rebuild never overwrites existing knowledge files directly**: it creates a set of AI proposals.
  Review the diffs under **AI suggestions (AI 建议)** and accept to write them (with a commit); reject
  and the old knowledge stays untouched;
- Cost is a few cents to a few dozen cents depending on book length. You can close the progress dialog
  (it keeps running in the background) or cancel it.

## 6. AI proposals and the outline wizard

- **AI proposals**: when the Agent wants to change an outline or setting it calls `propose_knowledge`.
  An **AI suggestions (AI 建议 N)** button appears in the top bar; open it to review each diff.
  Only **Accept and commit (接受并提交)** writes to the canon (and creates a Git commit); **Reject
  (拒绝)** discards it.
- **Outline wizard (大纲向导)**: top bar → one-sentence premise + number of volumes → generates main /
  volume / world-model proposals → reviewed as diffs before anything is written.

## 7. Versions, history and rollback

- **History (历史)** tab: every commit, click to see the diff;
- Chapter actions: the **···** menu next to the chapter title lets you insert (above/below), move up/down,
merge into the next chapter, split at the editor cursor, and renumber all chapters;
- Full-book search: `Ctrl/Cmd + F` searches chapters and knowledge files with click-to-jump; case-sensitive
  toggle, per-file or whole-book replace (one `[replace]` commit);
- Rollback: inside a history diff, click **Roll back to this version (回滚到此版本)**;
- Chapter text, knowledge files and `book.json` are all in Git; drafts are not in Git (they live in a
  separate versioned directory).

## 8. Context and budget

- The Assistant footer shows **context x / y**: automatically trimmed based on the selected model's
  `contextWindow`;
- For long conversations click **Compact (压缩)** (`/compact`): older turns are compressed into a
  summary, while the original messages stay in the session file;
- If a request still overflows the model context, the app **folds older messages, temporarily reduces
  the input budget and retries once** (the panel shows a recovery notice); only then do you need to
  compact manually or switch to a larger-context model;
- When a session or chapter budget reaches its threshold you get a warning; when exhausted, input is
  locked and restarting does not bypass it (change budgets in Settings).

## 9. Backup, restore and updates

- **Backup**: Settings → **Data safety (数据安全)** → **Back up library**; creates a zip that includes each
  book's `.git` history;
- **Automatic backups** are on by default: every 3 days into `<userData>/backups`, keeping the latest 5.
  You can switch to daily/weekly and 3/5/10 copies; manual backups are never pruned;
- **Restore**: pick a backup zip, review the book list in the dialog, and select only the books you need
  (books that already exist are marked and skipped). Existing data is never overwritten; the bookshelf
  refreshes afterwards;
- **Update**: Settings → **Updates (更新)** → **Check for updates (检查更新)**; the installer is
  downloaded and SHA256-verified, and only installs after you click **Restart and install
  (重启并安装)**;
- **Troubleshooting**: Settings → **Open log folder (打开日志目录)**. Logs are JSONL, rotate daily and
  stay local.

## 10. Export your book

The **Export (导出)** button in the top bar becomes available once you have canon chapters:

- **EPUB**: standard ebook format with a generated table of contents — good for e-readers / self-publishing;
- **Markdown**: one merged .md file — good for backup, further editing, or importing into other tools;
- **TXT**: plain text — good for web-serial platforms or sharing.

Pick a format → **Choose location and export (选择位置并导出)** → open the containing folder when done.
Export includes **canon chapters only** (no drafts) and never modifies the manuscript or Git history.

## 11. Consistency review (read-only)

Once a book grows, character ages, timelines and settings tend to contradict each other. Use **Consistency
(一致性)** in the top bar:

1. Choose a chapter range (empty = whole book; up to the latest 120 chapters per run) and an optional focus;
2. The model checks batches of chapters against the knowledge base and reports contradictions in characters,
   timeline, setting and plot;
3. Issues are grouped by high / medium / low severity, each with evidence (chapter or knowledge card) and a
   suggestion;
4. **Read-only**: the manuscript, knowledge files and Git history are never modified; the report is saved under
   the book's `.studio/reviews/` folder.

> Cost depends on chapter count; a few tens of thousands of characters is usually within a few cents.

## 12. FAQ

| Symptom | What to do |
|---|---|
| Sending a message does nothing / model error | Click **Test connection (测试连接)** and follow the auth/network/model hint; for OpenCode Go choose `opencode-go`; set the network proxy if needed |
| Input locked because the budget is exhausted | Raise the session/chapter budget in Settings, or click **Reset (重置)** in the Assistant to start a new session |
| Context is full | Click **Compact (压缩)**, or switch to a model with a larger context window |
| Update check fails | If GitHub API is unreachable, download manually from the Releases page |
| Book won't open / JSON corrupted | Restore from a backup, or inspect `book.json` in the library folder (the exact error is in the logs) |
| Moving to a new computer | Copy the backup zip over → install on the new machine → restore the backup |
