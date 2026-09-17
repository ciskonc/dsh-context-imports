# dsh-context-imports

Claude Code-style `@path` imports for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): expands `@imports` found in `AGENTS.md` / `CLAUDE.md` and injects the referenced files into model context at session start — so your workspace state, memory index, and user profile are actually in context, not just dead text references.

[中文说明](#中文说明)

## Why

DSH's stock `dsh-agent-instructions` plugin injects `AGENTS.md` itself, but — unlike Claude Code — it does **not** expand `@path` references inside it. If your `AGENTS.md` says:

```markdown
@00_BOOT/SYSTEM_STATE.md
@04_MEMORY/INDEX.md
@04_MEMORY/user/user_profile.md
```

those files are never read. This plugin fixes that: at session start it scans the instruction files for `@path` tokens, resolves them recursively (depth-limited), reads the files, and injects them as durable session context via the official `agent/session-start` + `agent.inject()` channel.

## Install

```bash
dsh plugin --profile web add dsh-context-imports@0.1.0
```

Then open **Settings → Plugins → Plugin configuration** — the plugin ships its own settings card (six languages: zh / en / ja / fr / ru / ko).

## How it works

1. On `agent/session-start` (sources: `startup` / `resume` / `clear` / `compact`, all enabled by default), the plugin collects:
   - `@path` imports found in the configured instruction files (default `AGENTS.md`, `CLAUDE.md`), recursively up to `maxDepth`
   - any explicitly configured `files`
2. Each file is read with a per-file byte cap (`maxFileBytes`) and a total budget (`maxTotalBytes`); missing files are reported as one-line notes instead of failing.
3. The bundle is injected as a single `<system-reminder>` context message. The instruction files themselves are **not** re-injected — the stock agent-instructions plugin already owns them; this plugin only injects what they *reference*.
4. The wrapper text follows the UI language preference (official `locale` settings namespace) and can be overridden with a custom `template` (`{{content}}` placeholder).

## Configuration

All fields are editable in the settings card, or via the `dsh-context-imports` settings namespace:

| Field | Default | Description |
|---|---|---|
| `files` | `[]` | Extra files to inject (relative to session cwd, or absolute) |
| `scanImports` | `true` | Scan instruction files for `@path` imports and expand them recursively |
| `instructionFiles` | `["AGENTS.md", "CLAUDE.md"]` | Instruction file candidates to scan |
| `maxDepth` | `3` | Maximum `@import` recursion depth |
| `maxFileBytes` | `65536` | Per-file byte cap |
| `maxTotalBytes` | `131072` | Total injection byte budget |
| `injectOn` | all four | Session-start sources that trigger injection (`startup`, `resume`, `clear`, `compact`) |
| `template` | `""` | Custom wrapper template with `{{content}}` placeholder; empty = locale default |

Notes:

- `@path` tokens inside fenced code blocks are ignored; tokens must carry a file extension.
- Import cycles and duplicates are collapsed by resolved path.
- Re-injection on `compact` is intentional: after compaction your workspace state files are re-seeded, so long sessions keep their memory.

## Development

```bash
npm install
DSH_CHECKOUT=<path-to-dsh-installation> bash scripts/build.sh   # host half → lib/index.js
npm run build:client                                            # browser half → lib/client.js
```

Built on official DSH API surface only: cordis events (`agent/session-start`), `agent.inject()` + `createUserMessage` (`@deepseek-ai/dsh-llm`), schemastery `Config`, and the optional `dsh-settings` namespace registration. No dependency on other feature plugins.

## License

[MIT](LICENSE)

---

## 中文说明

DSH 官方的 `dsh-agent-instructions` 插件只会注入 `AGENTS.md` 本体，**不会**像 Claude Code 那样展开其中的 `@路径` 引用——写了 `@00_BOOT/SYSTEM_STATE.md` 也只是死文本，Agent 根本读不到。本插件补齐这一能力：

- **会话启动时**（新会话/恢复/清空/压缩后四种场景，默认全开）自动扫描 `AGENTS.md`/`CLAUDE.md` 里的 `@路径` 引用，递归展开（默认深度 3），把被引用文件的内容注入模型上下文
- 支持额外的显式 `files` 文件列表；单文件 64KB / 总量 128KB 预算封顶；缺失文件只记一行提示不报错
- `AGENTS.md` 本体不重复注入（官方插件已负责），只注入它**引用的文件**
- 自带图形化设置卡片（设置 → Plugins → Plugin configuration），界面文案六语言（中/英/日/法/俄/韩），注入包装文本跟随 UI 语言，可用 `template` 自定义
- 压缩（compact）后会重新注入——长会话压缩后记忆文件自动"续命"

安装：

```bash
dsh plugin --profile web add dsh-context-imports@0.1.0
```

只使用 DSH 官方公开 API（cordis 事件 / `agent.inject()` / schemastery / dsh-settings），不依赖任何其他功能插件。MIT 许可。
