<div align="center">

# dsh-context-imports

<p align="center">DeepSeek Harness injects the <b>AGENTS.md file itself</b> — but the <b>@path references inside it are dead text</b>; the model never sees them. This plugin brings Claude Code's <b>@import mechanism</b> to DSH: at session start it <b>recursively expands</b> references (depth-limited, byte-budgeted, code-fence aware, missing-file tolerant) and injects the referenced files as durable context; <b>re-seeds after compaction</b>, and keeps <b>exactly one injection alive</b> per active history (event-shape-agnostic detection). Ships a <b>six-language settings card</b> (zh/en/ja/fr/ru/ko); the wrapper text follows the UI locale. Built on the official public API only (<code>agent/session-start</code> + <code>agent.inject()</code> + schemastery + dsh-settings) with <b>zero feature-plugin dependencies</b>.</p>

<p align="center">
  <a href="LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/ciskonc/dsh-context-imports"></a>
</p>

[中文](README.md) | English

</div>

---

## Why

| | Without | With dsh-context-imports |
|---|---|---|
| AGENTS.md itself | ✅ injected by the stock agent-instructions plugin | ✅ still owned by it (no duplication) |
| `@00_BOOT/SYSTEM_STATE.md` references | ❌ dead text | ✅ full file content injected as session context |
| Nested imports | ❌ nobody handles them | ✅ recursive, depth-limited |
| After compaction | ❌ state files vanish with history | ✅ re-injected on compact (re-seed) |
| Resumed sessions | — | ✅ existing injection detected → skip, never stacks |

## How it works

```text
agent/session-start (startup / resume / clear / compact)
  ├─ read config (settings-card edits apply live, no reload)
  ├─ scan instruction files (default AGENTS.md / CLAUDE.md) for @path imports
  │    ├─ fenced code blocks skipped; extensions required
  │    ├─ relative paths resolved against the importing file's directory
  │    └─ deduped by resolved path; import cycles are harmless
  ├─ merge explicit `files` (injected in full; instruction files are scan-only)
  ├─ budgets: 64KB per file (truncated + noted) / 128KB total (omitted + noted);
  │    missing files degrade to a one-line note
  ├─ single-injection invariant: prior injections detected across event shapes
  │    are skipped (messages persist as agent/inbox/spliced events, matched by
  │    source tag + zh/en wrapper fingerprints); compaction that removed the
  │    old block makes the session injectable again
  └─ one <system-reminder> context message via agent.inject() (official channel)
```

Wrapper language: explicit locale preference → browser-resolved language (synced by the client half) → English fallback; fully overridable via the `template` option (`{{content}}` placeholder).

## Features

- **Claude Code-style @imports** — write `@04_MEMORY/INDEX.md` in AGENTS.md and the model has "already read it" at turn one; no reliance on the agent remembering to run startup reads.
- **Four trigger scenes, all configurable** — startup / resume / clear / compact. Compaction re-seed is intentional.
- **Single-injection invariant** — verified against live session logs: injections persist as `agent/inbox/spliced` events (not `user/message`); detection matches across shapes via source tag and zh/en wrapper fingerprints.
- **Six-language settings card** — edit every option graphically under Settings → Plugins → Plugin configuration; UI copy in zh/en/ja/fr/ru/ko.
- **Budgets & fallbacks** — per-file/total byte caps, missing-file notes, code-fence awareness, cycle-safe dedupe.
- **Official API only** — cordis events, `agent.inject()` + `createUserMessage` (dsh-llm), schemastery Config, dsh-settings `installSection` (optional service). Zero feature-plugin dependencies.

## Configuration

| Field | Default | Description |
|---|---|---|
| `files` | `[]` | Extra files to inject (relative to session cwd, or absolute) |
| `scanImports` | `true` | Scan AGENTS.md and other instruction files for @imports |
| `instructionFiles` | `["AGENTS.md", "CLAUDE.md"]` | Files to scan (scan-only; never re-injected) |
| `maxDepth` | `3` | Max @import recursion depth |
| `maxFileBytes` | `65536` | Per-file byte cap (truncated beyond) |
| `maxTotalBytes` | `131072` | Total byte budget (omitted beyond) |
| `injectOn` | all four | Session-start scenes that trigger injection |
| `template` | `""` | Custom wrapper template with `{{content}}`; empty = locale default |

## Install

The npm package is coming soon — a one-line install command will appear here once published. Meanwhile, build from source:

```sh
git clone https://github.com/ciskonc/dsh-context-imports.git
cd dsh-context-imports
npm install
DSH_CHECKOUT=<path-to-your-dsh-installation> npm run build   # host half → lib/index.js
npm run build:client                                         # browser half → lib/client.js
```

The result is a standard DSH plugin package (`lib/`); load it into your profile and the settings card appears under **Settings → Plugins → Plugin configuration**.

## Development

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Host half: session-start listener, recursive @import expansion, budgets, injection, settings namespace |
| [src/client/index.ts](src/client/index.ts) | Browser entry: six-language dictionaries + `settings.plugin.item` keyed slot card |
| [src/client/form.ts](src/client/form.ts) | Minimal CardForm (ported from the official implementation, with an array read-back fix) |
| [src/client/ContextImportsCard.tsx](src/client/ContextImportsCard.tsx) | Card component (mirrors the official PluginCard structure and CSS variables) |

**Two iron rules for DSH client plugins** (learned the hard way — violations crash the host):

1. The `id` in `__ModuleLoader__.load({ id })` must equal the package.json `name` byte-for-byte — one extra scope prefix and the loader treats it as unregistered.
2. `inject` may only declare modules that actually exist in the shell module table (staticModules seed) — declaring a removed package (e.g. `@deepseek-ai/dsh-client-runtime`) crashes the session.

## License

[MIT](LICENSE)
