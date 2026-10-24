<div align="center">

# dsh-context-imports

Inject the files referenced from AGENTS.md into model context at session start.

DeepSeek Harness injects AGENTS.md itself, but the `@path` references inside it stay as plain text and the model never sees them. This plugin expands those references the way Claude Code does: it reads each referenced file and adds the content to the session context.

<p align="center">
  <a href="LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/ciskonc/dsh-context-imports"></a>
</p>

English | [中文](README.zh-CN.md)

</div>

---

## Why

| | Without this plugin | With it |
|---|---|---|
| AGENTS.md itself | Injected by the stock agent-instructions plugin | Still injected by it, no duplication |
| `@docs/architecture.md` references | Plain text, ignored | Full file content in context |
| Nested imports | Nobody handles them | Expanded recursively, depth limited |
| After compaction | Referenced files are gone with the history | Re-injected automatically |
| Resumed sessions | May stack a second copy | Skipped when one is already present |

## How it works

```text
agent/session-start (startup / resume / clear / compact) records the scene
agent/pre-step (every step) decides whether to inject
  ├─ scan the instruction files (default AGENTS.md, CLAUDE.md) for @path imports
  │    ├─ fenced code blocks are skipped; the path must have a file extension
  │    ├─ relative paths resolve against the importing file's directory
  │    └─ duplicates collapse by resolved path, so import cycles are harmless
  ├─ merge the explicit files list (injected in full; instruction files are
  │    scanned but never re-injected)
  ├─ budgets: 64 KB per file (truncated with a note), 128 KB total (skipped
  │    with a note); a missing file becomes a one-line note instead of an error
  ├─ at most one injection stays in the active history: the full event log is
  │    fingerprint-scanned, and compaction that removes the block re-enables it
  └─ the bundle is appended to the end of the step messages, after AGENTS.md
       and every other context injection
```

The injected message is a `<system-reminder>` containing `<file path="...">` blocks and nothing else. Set `template` if you want your own framing around it.

## Features

- Expands `@path` imports recursively. Default depth is 3; import cycles and duplicates are collapsed.
- Follows the imports of every instruction file the harness loaded — including a project's AGENTS.md it picks up mid-session once the agent touches files under it.
- Triggers on new sessions, resume, clear, and after compaction. Each scene can be turned off.
- Never sends the same file twice: a file already in the model's context is left alone, and a newly loaded instruction file adds exactly its own imported files.
- Six-language settings card (zh, en, ja, fr, ru, ko) under Settings, Plugins, Plugin configuration. Every option is editable there and applies without a reload.
- Byte budgets per file and in total. Missing files are reported, never fatal.
- Uses the official API surface only: cordis events, `createUserMessage` from dsh-llm, a schemastery config, and the optional dsh-settings namespace. No feature-plugin dependencies.

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
| `template` | `""` | Custom wrapper text. `{{content}}` marks where the files go; empty uses the plain wrapper |

## Install

```sh
dsh plugin --profile web add dsh-context-imports
```

It works with no configuration: AGENTS.md and CLAUDE.md are scanned and their imports injected. To build from source instead:

```sh
git clone https://github.com/ciskonc/dsh-context-imports.git
cd dsh-context-imports
npm install
DSH_CHECKOUT=<path-to-your-dsh-installation> npm run build
npm run build:client
```

## Compatibility

| Plugin version | DeepSeek Harness | Notes |
|---|---|---|
| **0.3.0+** | **≥ 0.2.0-rc.1**（0.3.0 tested on 0.2.1-rc.2） | Current line. Adds `expandLoadedInstructions`: the imports of every instruction file the harness loaded are expanded, including a project AGENTS.md it brings in mid-session. Injection is incremental — a file already in the context is never sent twice. Needs the host's published instruction scopes (`agent-instructions` message source + `agent.inbox.nextStep`), so it targets DSH ≥ 0.2.0 |
| 0.2.3 | ≥ 0.1.7-rc.1（tested on 0.2.0-rc.1, 0.2.0-rc.2 and 0.2.1-rc.2） | Config access hardened: on DSH ≥ 0.2.0-rc.2 the volatile config projection no longer fills schema defaults, so every field is normalized at entry (0.2.2 could crash session creation or silently skip injection there). Note: on DSH ≥ 0.2.0-rc.2 install via `dsh plugin add` only — the loader verifies lockfile consistency, hand-copied node_modules are silently dropped |
| 0.2.0 – 0.2.2 | ≥ 0.1.7-rc.1（0.2.1 tested on 0.1.7-rc.2 and 0.2.0-rc.1; 0.2.2 tested on 0.2.0-rc.1） | 0.2.2 fixed re-injection after compaction and settings-page mounting, but on DSH ≥ 0.2.0-rc.2 it can crash session creation (`injectOn.includes is not a function`) or silently skip injection (`cfg.files is not iterable`) — upgrade to 0.2.3 |
| 0.1.x | 0.1.5-rc.1 – 0.1.5-rc.3（tested on 0.1.5-rc.2/rc.3） | Legacy line. **Does not work on 0.1.7** — it waits on the removed `settingsScope` service and the removed `agent/session-start` event |

Each release note names the DSH version it was tested against.

## Development

| File | Role |
|---|---|
| `src/index.ts` | Host side: session-start ledger, import expansion, budgets, pre-step injection, settings namespace |
| `src/client/index.ts` | Browser side: six-language dictionaries and the settings card slot |
| `src/client/form.ts` | Staged form model behind the card |
| `src/client/ContextImportsCard.tsx` | The card component |

## License

[MIT](LICENSE)
