# Novel Studio

<img src="docs/assets/logo.png" width="96" alt="Novel Studio logo" />

[![CI](https://github.com/JeffGuo7/novel_studio/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffGuo7/novel_studio/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JeffGuo7/novel_studio?display_name=tag&sort=semver)](https://github.com/JeffGuo7/novel_studio/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CodeQL](https://github.com/JeffGuo7/novel_studio/actions/workflows/codeql.yml/badge.svg)](https://github.com/JeffGuo7/novel_studio/actions/workflows/codeql.yml)

[简体中文](README.md) · English

A local-first AI novel-writing studio for Windows. **Markdown is the single source of truth, Git tracks
the canon, drafts live in their own versioned store, and the AI can never archive anything by itself.**

Built with Electron + React + TypeScript + isomorphic-git + the [pi agent SDK](https://github.com/earendil-works/pi).
Your manuscripts stay on your own disk; the model only sees a book when you explicitly start a turn.

> **Note on localization:** the application UI is currently Simplified Chinese only. This English README
> is intended for international developers, reviewers and contributors. A full English UI is on the
> roadmap, but is intentionally deferred until there is real demand from non-Chinese writers.

![Bookshelf](docs/assets/shelf.png)

## Download & install

Windows x64: grab `Novel Studio-Setup-<version>-x64.exe` from [Releases](https://github.com/JeffGuo7/novel_studio/releases),
or use the portable build.

> The installer is **not code-signed** (the SignPath Foundation requires broader community adoption, so the application was not approved this time; we may reapply later, and a paid OSS certificate such as Certum is another option).
> Windows SmartScreen will show an "unknown publisher" warning; verify the SHA256 checksum published
> with each release. After first launch, open **Settings** (本机配置), pick a provider / model and paste an API key
> (DeepSeek / OpenCode / OpenAI / Anthropic / any OpenAI-compatible endpoint), then create your first book.

## What problem does it solve?

Writing a novel with ChatGPT/Claude usually fails for engineering reasons, not because the model "can't write":

| Problem | What Novel Studio does |
|---|---|
| AI overwrote your manuscript and you can't get it back | Every save/archive is a Git commit — diff and roll back anytime |
| AI drafts leak into the canon | Drafts live in `.studio/drafts`, outside Git; only the author can "archive" a draft |
| The model doesn't know earlier chapters | A distilled knowledge base (world / status / synopsis / outlines / style + character, place, faction cards + volume summaries) is injected into context; long books are chunked and distilled |
| The style drifts away from yours | Style fingerprint + drift detection |
| Token costs run away | Session + per-chapter budgets with hard stops and configurable warnings; restarting doesn't bypass them |
| Moving to a new machine loses history | Everything is plain files + nested Git — copy the folder and you're done |

## Features

**Writing & versioning**

- Bookshelf, chapters, and knowledge files (world model / status card / synopsis / four levels of outlines / style guide / error archive) — all Markdown
- Saving a chapter creates a commit; history timeline, word-level diff, and rollback (rollback is also a commit, so nothing is ever lost)
- Drafts are versioned independently: inspect any version, continue from an older baseline, archive a draft as the canon chapter, or discard the whole chapter draft
- **Chapter management**: insert above/below, move up/down, merge into the next chapter, split at the editor cursor, renumber; drafts, pipeline hashes, session costs and the search index are migrated together
- **Autosave / crash recovery**: 2.5s after you stop typing, edits are written to `.studio/autosave`; reopening the app offers Restore/Discard, and a successful save clears it
- **Full-book search / replace**: `Ctrl/Cmd + F` searches chapters and knowledge files with click-to-jump; case-sensitive toggle and per-file/whole-book replace, committed as one `[replace]` Git commit
- Deletion is safe: deleting a chapter creates a `[delete]` commit; trashing a book moves it to the library's `.trash` folder instead of destroying it
- **Export**: whole book to Markdown (single merged file) / TXT (markup stripped) / EPUB (standard ebook with generated TOC); canon chapters only, drafts excluded

**Import**

- Paste text, import multiple local files, or use the Fanqie (番茄) source through your local downloader (optional)
- Detects UTF-8 / GB18030, splits chapters by `第 N 章 / 序章 / 楔子 / Chapter N`, and imports in a single commit

**Knowledge pipeline**

- Initialization distills chapters into synopsis / world model / status card / per-chapter outline / style guide / style fingerprint
- Incremental updates process only new chapters; the status card rolls forward
- Stale detection records a content hash per chapter; edited/deleted canon chapters trigger a full rebuild prompt; a **rebuild is a major change, so it produces AI proposals instead of overwriting existing knowledge files** — you review the diff and accept before anything is written
- Style fingerprint is computed locally (sentence length, paragraph length, dialogue ratio, POV, recurring imagery); the model interprets the metrics, never invents numbers

**Agent (pi-based)**

- Runs in an isolated `utilityProcess`; tools are limited to **read context / read chapter / story search / write draft** — **no archive or delete permission**
- Streaming, interrupt, interject; sessions persist and restore chat bubbles plus tool traces after restart
- Cost accounting: session + per-chapter budgets, blocked input when exceeded, configurable warning threshold (default 80%)
- Model-driven context budget: derived from the model's `contextWindow / maxTokens`, automatically trims history and the context pack, and shows usage in the panel
- **`/compact` conversation compaction**: compress older turns into a structured summary while keeping the original messages
- **Context-overflow fallback**: when a request overflows the model context, older messages are folded, the input budget is temporarily reduced, and the request is retried once; only then does it ask you to compact or switch models
- **`search_story`**: local full-text index (MiniSearch + Chinese 1/2-gram) covering both chapters and knowledge cards (characters / locations / factions / volume summaries), with optional chapter-range filtering — **no embedding model required**
- **Auto update**: checks GitHub Releases, downloads the installer, verifies SHA256, and installs only after you confirm
- **Connection test + in-app proxy**: one-click model connectivity test (auth/network/model errors differentiated) and an HTTP proxy used by both model requests and update checks
- **Data safety**: local zip backup/restore of the whole library (including each book's `.git` history); **automatic backups** (every 3 days by default, keeps the latest 5; manual backups are never pruned); restore can target only selected books, and same-name books are skipped, never overwritten
- **Observability**: structured JSONL logs + renderer error boundary + crash fallback page; logs stay local and can be opened from Settings
- **Chapter word-count cache**: `.studio/cache/chapters.json` keeps word counts keyed by file size/mtime, so snapshots of large books never re-read every chapter (1000 chapters: 197ms cold → 67ms warm)
- **AI knowledge proposals**: the agent can only write proposals via `propose_knowledge`; you review the diff and accept before anything enters the canon (and creates a commit)
- **Outline wizard**: one-sentence premise → main / volume / world-model proposals, also reviewed as diffs before writing

**Consistency review (read-only)**

- Top-bar **Consistency (一致性)** → pick a chapter range / focus → the model lists contradictions in characters, timeline, setting and plot with severity levels; read-only, never edits the manuscript, and saves a report under `.studio/reviews`

**Style drift**

- Compares the current chapter/draft with the style fingerprint; warning pill appears when sentence length, paragraph length or dialogue ratio drift past thresholds

**Distribution**

- `npm run release` produces an NSIS installer + portable build + SHA256 checksums + release notes
- Code signing: not enabled yet — SignPath Foundation requires broader community adoption (application not approved this time; reapply later or use a paid certificate such as Certum); SmartScreen may warn until then (verify the checksum)

![Workbench](docs/assets/workbench.png)

![Export](docs/assets/export.png)

![Chapter actions](docs/assets/chapter-menu.png)

![Autosave recovery](docs/assets/autosave.png)

![Full-book search](docs/assets/search.png)

![Connection test](docs/assets/connection.png)

![Consistency review](docs/assets/review.png)

![Agent drafting](docs/assets/agent-draft.png)

![Knowledge base](docs/assets/knowledge-done.png)

![Style drift](docs/assets/style-drift-detail.png)

## Quick start (development)

Requirements: Node.js ≥ 20 (developed on 24), Windows 10/11.

```powershell
npm install
copy .env.example .env.local     # optional: you can also set the API key in Settings after launch
npm run dev                      # dev mode with hot reload
```

First launch → **Settings** → choose provider / model / paste key → create a book → write or import chapters → let the Agent draft.

The default model is `deepseek-flash` (cheap and good enough); the built-in catalog mirrors pi's full list
(41 providers / 1599 models) and also supports custom OpenAI-compatible endpoints. OpenCode Zen / Go are
included: pick `opencode-go` for the Go plan (the app automatically attaches the `x-opencode-session` routing header).

### Common commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development mode |
| `npm run build` | Build app + Agent/knowledge utilityProcess bundles |
| `npm test` | Unit tests (208, faux provider, no token cost) |
| `npm run typecheck` | Type checking |
| `npm run lint` | oxlint |
| `npm run test:coverage` | Coverage (logic layer threshold 70%) |
| `npm run release` | Build installer + portable + checksums + release notes |
| `npm run e2e:smoke` | UI smoke: screenshots + settings/backup/restore |
| `npm run e2e:agent` | Real-model end-to-end (needs a key, costs money) |
| `npm run doctor:update -- --download` | Update-chain rehearsal: check Release + download + verify SHA256 |
| `npm run eval:retrieval` | Retrieval quality gate (CI requires hit@5 = 100%) |
| `npm run e2e:export` | Export end-to-end: Markdown / TXT / EPUB |
| `npm run e2e:chapters` | Chapter management end-to-end: insert / move / merge / split / renumber |
| `npm run e2e:autosave` | Autosave / crash-recovery end-to-end |
| `npm run e2e:book-search` | Full-book search / replace end-to-end |
| `npm run e2e:review` | Consistency review end-to-end (needs a key, low cost) |
| `npm run e2e:connection` | Real model connection test + proxy (needs a key, tiny cost) |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + F` | Full-book search / replace |
| `Ctrl/Cmd + S` | Save current chapter / knowledge file |
| `Enter` | Send message to Agent |
| `Shift + Enter` | New line in message |
| `Esc` | Close dialogs; interrupt Agent generation |
| `Tab / Shift + Tab` | Cycle focus inside dialogs |

## Data & privacy

| Content | Location |
|---|---|
| Library (Markdown + nested Git) | `%USERPROFILE%\Documents\NovelStudio` (override with `NOVEL_STUDIO_HOME`) |
| Settings (models, budgets, encrypted key) | `%APPDATA%\Novel Studio\settings.json` (override with `NOVEL_STUDIO_USER_DATA`) |
| Agent session | `<book>/.studio/agent/session.json` (`.studio` is ignored by the book's Git) |

- API keys are encrypted with the OS safeStorage and never written into books or sent outside the main process;
- No telemetry, no cloud account; network requests happen only when you explicitly start a model turn;
- The Fanqie source talks only to your local downloader (`127.0.0.1:18423`); the app does not scrape sites.

## Architecture

```text
┌──────────────────────────── renderer (React) ────────────────────────────┐
│ bookshelf / workbench / assistant / settings / import / style drift       │
└───────────────────────────────┬──────────────────────────────────────────┘
                     contextBridge (preload) │ typed IPC
┌───────────────────────────────┴──────────────────────────────────────────┐
│ main (Electron)                                                          │
│  books / git / drafts IPC · settings(safeStorage) · PipelineManager      │
│  AgentManager ──fork──► utilityProcess: out/agent/host.mjs  (pi Agent)   │
│               └──fork──► utilityProcess: out/pipeline/host.mjs (distill) │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
                    src/core (pure Node, unit-testable)
            book / chapters / drafts / git(isomorphic-git) / import / fsutil
```

- The main process never calls models: Agent and knowledge pipeline run in separate `utilityProcess`es so long loops can't freeze the window;
- **Data schema & migrations**: workspace `workspace.json` and per-book `.studio/schema.json` carry a schemaVersion; metadata is backed up before an upgrade, and data newer than the app is rejected with an upgrade prompt (see [docs/schema.md](docs/schema.md));
- `src/core` depends only on Node; all state is derived from the filesystem, with no separate database;
- Writes are restricted by a path whitelist (chapter Markdown + knowledge files), so the Agent cannot escape the book directory.

## Tests & CI

- 208 unit tests: core (books/chapters/drafts/Git/import/delete/export/chapter-structure/autosave/book search/data migration), Agent tools (including `search_story` / `propose_knowledge`) and context budget, session compaction, story index, AI proposals, outline generation, entity/volume cards, model registry, session cost, knowledge pipeline, style drift, Fanqie adapter (local stub), OpenCode adapter;
- E2E scripts: `e2e-screenshots` / `e2e-assistant` / `e2e-session` / `e2e-knowledge` / `e2e-import-ui` / `e2e-budget-warn` / `e2e-style-drift` / `e2e-window-close` / `e2e-delete` / `e2e-opencode` / `e2e-proposals` / `e2e-outline` / `e2e-packaged`;
- CI: GitHub Actions, Windows + Ubuntu run `typecheck` + `lint` + `test:coverage` + retrieval gate + `build`; Windows additionally runs a UI E2E smoke job; CodeQL scans weekly; Dependabot checks dependencies weekly.

## Build & distribution

```powershell
npm run release
```

Artifacts in `release/`:

- `Novel Studio-Setup-<version>-x64.exe` (NSIS installer, per-user)
- `Novel Studio-Portable-<version>-x64.exe` (portable)
- `SHA256SUMS.txt` + `RELEASE-<version>.md`

No code signature yet: SmartScreen may show "Windows protected your PC" (More info → Run anyway).
Verify the SHA256 first. Code signing is not enabled yet: SignPath Foundation requires stronger community
visibility (reapplication is possible later), and paid options such as a Certum OSS certificate exist;
see [docs/release.md](docs/release.md).

## Known limitations

- Windows only for now (macOS/Linux could be added; not verified);
- The online book source depends on a local Fanqie downloader; no scraper is bundled;
- One Agent process per book; multiple books can't chat simultaneously;
- One session per book; session branching is not supported yet;
- The current installer is unsigned (SignPath Foundation requires broader visibility; application not approved this time, reapply later or use a paid certificate). Auto-update is supported (GitHub Releases + SHA256 + user-confirmed install).

## Repository layout

```text
src/
  core/       library, chapters, drafts, Git, import, file utilities
  agent/      Agent host (pi), tools, prompts, session state, model registry
  pipeline/   knowledge pipeline (distillation / incremental / style)
  main/       Electron main process, IPC, Agent/Pipeline managers, settings
  preload/    contextBridge API
  renderer/   React UI (bookshelf / workbench / assistant / import / settings)
  shared/     cross-process types and pure functions (style metrics, model catalog)
tests/        208 vitest cases
scripts/      build, catalog generation, release, E2E
docs/         design / architecture / pipeline / release docs (mostly Chinese)
```

## Contributing

- Development setup and contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security issues: please report privately via [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Documentation

Most design docs are currently in Chinese. Start here:

- [Product positioning](PRODUCT.md)
- [UI design system](docs/ui-design.md)
- [Agent architecture](docs/agent.md)
- [Git & versioning strategy](docs/git-strategy.md)
- [Import](docs/import.md)
- [Knowledge pipeline](docs/knowledge-pipeline.md)
- [Story search (no embeddings)](docs/story-index.md)
- [Performance benchmark (1000 chapters)](docs/performance.md)
- [Retrieval quality evaluation](docs/retrieval-eval.md)
- [Observability & crash handling](docs/observability.md)
- [Getting started guide (English)](docs/getting-started.en.md) · [简体中文](docs/getting-started.md)
- [Release process](docs/release.md)

## License

[MIT](LICENSE) © 2025-2026 JeffGuo7 and Novel Studio contributors