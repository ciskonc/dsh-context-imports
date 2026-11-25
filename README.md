<div align="center">

# dsh-context-imports

**A DeepSeek Harness plugin that turns the `@path` imports inside AGENTS.md into real file content in the model's context.**

DeepSeek Harness injects AGENTS.md itself, but the `@path` references inside it stay as plain text the model never sees. This plugin reads each referenced file and adds the content to the session context.

<p align="center">
  <a href="LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/ciskonc/dsh-context-imports"></a>
</p>

English | [中文](README.zh-CN.md)

</div>

---

## Introduction

dsh-context-imports is a DeepSeek Harness plugin that expands `@path` references found in instruction files and injects the referenced files into the session context. AGENTS.md itself keeps being injected by the stock agent-instructions plugin, so nothing is duplicated.

On its own, DeepSeek Harness injects AGENTS.md itself, but the `@path` references inside stay plain text the model never sees, and imports nested deeper than the first level have no handler at all.

Once the plugin takes over, every referenced file enters the context in full.

## How it works

```text
agent/created (startup / resume / clear / compact) records the scene
agent/pre-step (every step) decides whether to inject
  ├─ scan the instruction files (default AGENTS.md, CLAUDE.md) for @path imports
  │    ├─ fenced code blocks are skipped; the path must have a file extension
  │    ├─ relative paths resolve against the importing file's directory
  │    ├─ duplicates collapse by resolved path, so import cycles are harmless
  │    └─ a relative reference resolving outside the working directory is
  │         refused and reported instead of read (absolute references are
  │         not fenced)
  ├─ merge the explicit files list (injected in full; instruction files are
  │    scanned but never re-injected)
  ├─ budgets: 64 KB per file (truncated with a note), 128 KB total (skipped
  │    with a note); a missing file becomes a one-line note instead of an error
  ├─ dedup is incremental at the block level: a rendered file block already
  │    on the surface is never resent, changed content is re-injected, and
  │    compaction that removes the block from the surface re-enables it
  ├─ live mode (default off) watches the injected files between steps and
  │    re-injects what changed, debounced and interval-throttled
  └─ the bundle is appended to the end of the step messages, after AGENTS.md
       and every other context injection
```

The injected message is a `<system-reminder>` containing `<file path="...">` blocks and nothing else. Set `template` if you want your own framing around it.

## Features

- Expands `@path` imports recursively. Default depth is 3; import cycles and duplicates are collapsed. It also follows the imports of every instruction file the harness loaded — including a project's AGENTS.md it picks up mid-session once the agent touches files under it.
- Injection happens on new sessions, resume, clear and after compaction, and each scene can be turned off. Optional live mode (default off) picks up file changes while the session runs.
- Incremental injection: an unchanged file already in the context is never resent, changed content is re-injected, and a newly loaded instruction file adds exactly its own imported files.
- Two mechanisms keep file churn in check: change events are debounced (`watchDebounceMs`), so a burst of saves collapses into one watch pass, and re-injection of the same file is throttled by `minReinjectIntervalMs`, so editor churn cannot flood the context.
- Workspace fence: a relative reference found by scanning must resolve inside the session working directory, and a path outside it is never read — its slot carries a six-language outside-note instead of file content. Absolute references are not fenced.
- Byte budgets apply per file and in total, and a missing file is reported rather than fatal. Truncation applies to injected text only: nested scanning still reads the full file, so references near the end of a large file are never lost.
- Unicode-aware scanning: CJK and other non-ASCII paths match and inject.
- Six-language settings card (zh, en, ja, fr, ru, ko) under Settings, Plugins, Plugin configuration. Every option is editable there and applies without a reload.
- Uses the official API surface only: cordis events, `createUserMessage` from dsh-llm, a schemastery config, and the client-side `slots`, `locale` and `configForms` services. No feature-plugin dependencies.

## Configuration

| Field | Default | Description |
|---|---|---|
| `files` | `[]` | Extra files to inject, relative to the session working directory or absolute |
| `scanImports` | `true` | Scan AGENTS.md and the other instruction files for @imports |
| `instructionFiles` | `["AGENTS.md", "CLAUDE.md"]` | Files to scan. They are never re-injected themselves |
| `expandLoadedInstructions` | `true` | Also follow the imports of the instruction files the harness itself loaded, including a project AGENTS.md it brought in mid-session |
| `maxDepth` | `3` | How many levels of nested imports to follow |
| `maxFileBytes` | `65536` | Per-file cap in bytes; larger files are truncated |
| `maxTotalBytes` | `131072` | Total budget; files beyond it are skipped with a note |
| `injectOn` | all four | Which session-start scenes trigger injection |
| `liveMode` | `off` | Optional live mode (default off). Set it in the settings page: `off` = same as 0.3.1, `inject` = re-inject changed files on the next interaction, `inject+wake` = wake an idle agent right away. A burst of edits inside the throttle window is coalesced, so the last edit still reaches every session |
| `watchDebounceMs` | `30000` | Debounce window for file-change events |
| `minReinjectIntervalMs` | `300000` | Minimum interval between re-injections of the same file (churn throttle) |
| `detectedLocale` | `""` | Browser-resolved UI language, written by the client half so the host can wrap injected text in the interface language |
| `template` | `""` | Custom wrapper text. `{{content}}` marks where the files go; empty uses the plain wrapper |

## Installation

<details>
<summary>Install via dsh plugin</summary>

```sh
dsh plugin --profile web add dsh-context-imports
```

It works with no configuration: AGENTS.md and CLAUDE.md are scanned and their imports injected into the session.

</details>

<details>
<summary>Build from source</summary>

```sh
git clone https://github.com/ciskonc/dsh-context-imports.git
cd dsh-context-imports
npm install
DSH_CHECKOUT=<path-to-your-dsh-installation> npm run build
npm run build:client
```

</details>

## Compatibility

| Plugin version | DeepSeek Harness | Notes |
|---|---|---|
| **0.6.1** | **≥ 0.2.0**（tested on 0.2.2-rc.5 and 0.2.1-rc.5） | Current line. Peer dependencies now name `@deepseek-ai/cosmokit` explicitly, so a standard install no longer resolves a cosmokit without `createVolatile` (that mismatch left the whole plugin silent and inactive). Settings reject non-positive numbers, multi-line fields render one entry per line, `@reference` after full-width punctuation is recognised, and a burst of edits no longer loses its last change |
| 0.6.0 | ≥ 0.2.0（tested on 0.2.2-rc.5 and 0.2.1-rc.5） | Current line. Adversarial-audit hardening: settings-page liveMode save fixed (string enum), workspace fence on scanned imports, CJK paths, wake-burst dedup. Incremental injection unchanged |
| 0.3.1 – 0.5.1 | ≥ 0.2.0-rc.1（0.3.1 tested on 0.2.1-rc.2 and 0.2.1-rc.3） | Adds `expandLoadedInstructions`: the imports of every instruction file the harness loaded are expanded, including a project AGENTS.md it brings in mid-session. Injection is incremental — a file already in the context is never sent twice. Needs the host's published instruction scopes (`agent-instructions` message source + `agent.inbox.nextStep`), so it targets DSH ≥ 0.2.0 |
| 0.3.0 | ≥ 0.2.0-rc.1（tested on 0.2.1-rc.2） | Same feature, but the inbox lookup read `session.inbox` instead of `agent.inbox` and therefore never fired — the step-batch path carried the feature on its own. Fixed in 0.3.1 |
| 0.2.3 | ≥ 0.1.7-rc.1（tested on 0.2.0-rc.1, 0.2.0-rc.2 and 0.2.1-rc.2） | Config access hardened: on DSH ≥ 0.2.0-rc.2 the volatile config projection no longer fills schema defaults, so every field is normalized at entry (0.2.2 could crash session creation or silently skip injection there). Note: on DSH ≥ 0.2.0-rc.2 install via `dsh plugin add` only — the loader verifies lockfile consistency, hand-copied node_modules are silently dropped |
| 0.2.0 – 0.2.2 | ≥ 0.1.7-rc.1（0.2.1 tested on 0.1.7-rc.2 and 0.2.0-rc.1; 0.2.2 tested on 0.2.0-rc.1） | 0.2.2 fixed re-injection after compaction and settings-page mounting, but on DSH ≥ 0.2.0-rc.2 it can crash session creation (`injectOn.includes is not a function`) or silently skip injection (`cfg.files is not iterable`) — upgrade to 0.2.3 |
| 0.1.x | 0.1.5-rc.1 – 0.1.5-rc.3（tested on 0.1.5-rc.2/rc.3） | Legacy line. **Does not work on 0.1.7** — it waits on the removed `settingsScope` service and the removed `agent/session-start` event |

## Notes

- **Configure live mode in the settings page, not by hand.** `dsh plugin add` and `pnpm add` rewrite this plugin's section of the profile patch, and a hand-written `liveMode` / `watchDebounceMs` / `minReinjectIntervalMs` in that section does not survive an install or upgrade. Set them once in Settings → Plugins → Context imports.
- **Unsaved edits are dropped when the page reloads.** The host settings form offers Save only; there is no Discard button.
- **A `@reference` without a file extension is reported as ignored** instead of being silently dropped - the scanner needs an extension to recognise a path.

- **Closing a session tab does not stop live wakes** (the host reports no such event). Set **Wake scope** to "Only the session I used last" in the settings page so background sessions stop being woken.
- **Settings changes take effect after the DSH instance restarts** - saving writes the profile, but the running session host keeps its loaded configuration until restart. This is a host behavior, and the save area in the settings card reminds you of it.
## License

[MIT](LICENSE)