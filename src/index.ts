/**
 * dsh-context-imports — host half.
 *
 * Expands Claude Code-style `@path` imports found in workspace instruction
 * files (AGENTS.md / CLAUDE.md) and injects the referenced files into model
 * context via the official `agent/created` scene ledger + `agent/pre-step`
 * waterfall. Optionally merges an explicit `files` list.
 *
 * Official API surface only (0.1.7): cordis events (agent/created,
 * agent/pre-step), dsh-llm createUserMessage with a module-merged source
 * kind, schemastery Config. Configuration rides the loader patch — no
 * settings registration needed.
 */
import { appendFileSync, watch as fsWatchSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent' // pulls the cordis Events augmentation (agent/created, agent/pre-step)
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-context-imports'

/** Message source kind registered into the dsh-llm source map (0.1.7 pattern). */
export interface ContextImportsSource {
  kind: 'context-imports'
  form: 'instructions'
}

/**
 * Source for the wake turn of live mode (`inject+wake`). Deliberately NOT
 * `context-imports`: the pre-step `inBatch` guard skips a step whose batch
 * already carries one of our injection messages, and the whole point of the
 * wake turn is for the NEXT gate evaluation to inject the changed files.
 */
export interface ContextImportsWakeSource {
  kind: 'context-imports-wake'
  form: 'wake'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-imports': ContextImportsSource
    'context-imports-wake': ContextImportsWakeSource
  }
}

const SOURCES = ['startup', 'resume', 'clear', 'compact'] as const

export interface Config {
  /** Extra files to inject (relative to session cwd, or absolute). */
  files: string[]
  /** Scan instruction files for `@path` imports and expand them recursively. */
  scanImports: boolean
  /** Instruction file candidates to scan (content NOT re-injected: the stock agent-instructions plugin owns them). */
  instructionFiles: string[]
  /**
   * Expand the imports of every instruction file the HOST has loaded — not
   * only the ones next to the session cwd. The host loads a project's
   * AGENTS.md mid-session once the agent touches files under it, and that
   * file's `@import` targets would otherwise never reach the model.
   */
  expandLoadedInstructions: boolean
  /** Maximum @import recursion depth. */
  maxDepth: number
  /** Per-file byte cap. */
  maxFileBytes: number
  /** Total injection byte cap. */
  maxTotalBytes: number
  /** Session-start sources that trigger injection. */
  injectOn: string[]
  /**
   * Live mode for watched files. `off` (default) behaves exactly like 0.3.1;
   * `inject` re-injects changed files on the next interaction; `inject+wake`
   * additionally wakes an idle agent right away via `agent.followup`.
   */
  liveMode: 'off' | 'inject' | 'inject+wake'
  /** Debounce window for file-change events (editors often fire twice). */
  watchDebounceMs: number
  /** Minimum interval between re-injections of the same file (churn throttle). */
  minReinjectIntervalMs: number
  /** Custom wrapper template with {{content}} placeholder; empty = locale default. */
  template: string
  /** Auto-written by the client half: the browser-resolved UI language. Lets the host follow the UI locale when the user has no explicit locale preference. */
  detectedLocale: string
}

export const Config = z.object({
  // Every field is `.volatile()` (settings-page mount, iron rule 3).
  // Volatile fields arrive from cordis as a LIVE REFERENCE object
  // ({ get(), write() } protocol from cosmokit) - normalizeConfig unwraps
  // each field with .get() before use, so patch values, schema defaults and
  // live runtime updates all flow through (verified 0.2.1-rc.5/0.2.2-rc.1).
  files: z.array(z.string()).default([]).volatile(),
  scanImports: z.boolean().default(true).volatile(),
  instructionFiles: z.array(z.string()).default(['AGENTS.md', 'CLAUDE.md']).volatile(),
  expandLoadedInstructions: z.boolean().default(true).volatile(),
  maxDepth: z.number().default(3).volatile(),
  maxFileBytes: z.number().default(64 * 1024).volatile(),
  maxTotalBytes: z.number().default(128 * 1024).volatile(),
  injectOn: z.array(z.string()).default([...SOURCES]).volatile(),
  liveMode: z.string().default('off').volatile(),
  watchDebounceMs: z.number().default(30_000).volatile(),
  minReinjectIntervalMs: z.number().default(300_000).volatile(),
  template: z.string().default('').volatile(),
  detectedLocale: z.string().default('').volatile(),
})

/* ------------------------------------------------------------------ *
 * Locale status words (model-facing). No intro prose: the
 * <system-reminder> wrapper and <file path> tags carry the structure;
 * only the truncation/missing/omitted status lines are localized.
 * ------------------------------------------------------------------ */

interface Wrapper {
  truncated: string
  missing: string
  omitted: string
}

const WRAPPERS: Record<string, Wrapper> = {
  en: {
    truncated: 'truncated at',
    missing: 'referenced but not found',
    omitted: 'omitted: total byte budget reached',
  },
  zh: {
    truncated: '已截断于',
    missing: '被引用但文件不存在',
    omitted: '已省略：超出总字节预算',
  },
  ja: {
    truncated: 'バイト数で切り詰め:',
    missing: '参照されていますが見つかりません',
    omitted: '省略: 合計バイト予算に達しました',
  },
  fr: {
    truncated: 'tronqué à',
    missing: 'référencé mais introuvable',
    omitted: 'omis : budget total d’octets atteint',
  },
  ru: {
    truncated: 'обрезано на',
    missing: 'указан, но не найден',
    omitted: 'пропущено: достигнут общий лимит байт',
  },
  ko: {
    truncated: '다음 바이트에서 잘림:',
    missing: '참조되었지만 찾을 수 없음',
    omitted: '생략됨: 전체 바이트 예산 도달',
  },
}

function wrapperFor(locale: string | undefined): Wrapper {
  return (locale && WRAPPERS[locale]) || WRAPPERS.en
}

/* ------------------------------------------------------------------ *
 * Import scanning
 * ------------------------------------------------------------------ */

/** `@path` tokens: start of line (optionally bulleted) or inline after whitespace. Requires a file extension. */
const IMPORT_RE = /(?:^|[\s>(])@((?:[\w.\-~]+[\/\\])*[\w.\-~]+\.[A-Za-z0-9]+)/gm

function stripCodeFences(text: string): string {
  return text.replace(/^(`{3,}|~{3,})[\s\S]*?^\1/gm, '')
}

function findImports(text: string): string[] {
  const clean = stripCodeFences(text)
  const out: string[] = []
  for (const match of clean.matchAll(IMPORT_RE)) {
    const p = match[1]
    if (p.includes('://')) continue
    out.push(p)
  }
  return out
}

interface QueueItem {
  abs: string
  rel: string
  depth: number
  /** Instruction files are scanned for imports but their content is not re-injected. */
  scanOnly: boolean
}

/** One instruction file the host has loaded, with its absolute path. */
interface LoadedInstruction {
  abs: string
  /** Path as the host displays it (project-root relative). */
  rel: string
}

interface Bundle {
  /** Rendered blocks, ready to be wrapped. */
  blocks: string[]
  /** Absolute paths of the files actually injected this round (watch list source). */
  filePaths: string[]
  fileCount: number
  missingCount: number
  omittedCount: number
}

async function collectBundle(
  cfg: Config,
  cwd: string,
  extraInstructions: LoadedInstruction[],
  already: Set<string>,
  wrapper: Wrapper,
): Promise<Bundle> {
  const seen = new Set<string>()
  const queue: QueueItem[] = []
  const blocks: string[] = []
  const filePaths: string[] = []
  let fileCount = 0
  let missingCount = 0
  let omittedCount = 0
  let total = 0

  const enqueue = (abs: string, rel: string, depth: number, scanOnly: boolean) => {
    const key = abs.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    queue.push({ abs, rel, depth, scanOnly })
  }

  for (const f of cfg.files) {
    if (!f.trim()) continue
    enqueue(isAbsolute(f) ? f : resolve(cwd, f), f, 0, false)
  }
  if (cfg.scanImports) {
    // The cwd-level candidates keep the plugin working when the host has not
    // published any instruction scope (and after a compaction replaced the
    // host's own instruction messages).
    for (const f of cfg.instructionFiles) {
      enqueue(resolve(cwd, f), f, 0, true)
    }
    // Instruction files the HOST loaded — including a project's AGENTS.md
    // spliced in mid-session because the agent touched files under it.
    for (const instruction of extraInstructions) {
      enqueue(instruction.abs, instruction.rel, 0, true)
    }
  }

  while (queue.length > 0) {
    const item = queue.shift()!
    let raw: Buffer
    try {
      raw = await readFile(item.abs)
    } catch {
      if (!item.scanOnly) {
        const note = `[${wrapper.missing}] ${item.rel}`
        if (!already.has(note)) {
          blocks.push(note)
          missingCount++
        }
      }
      continue
    }
    let truncatedAt: number | undefined
    if (raw.byteLength > cfg.maxFileBytes) {
      truncatedAt = cfg.maxFileBytes
      raw = raw.subarray(0, cfg.maxFileBytes)
    }
    const text = raw.toString('utf8')

    // Scan for nested imports first (content or scan-only alike).
    if (item.depth < cfg.maxDepth) {
      for (const imp of findImports(text)) {
        const abs = isAbsolute(imp) ? imp : resolve(dirname(item.abs), imp)
        enqueue(abs, imp, item.depth + 1, false)
      }
    }

    if (item.scanOnly) continue
    const truncation = truncatedAt !== undefined ? `\n[${wrapper.truncated} ${truncatedAt} bytes]` : ''
    const block = `<file path="${item.rel}">\n${text}${truncation}\n</file>`
    // Already in the model's context (previous step, previous process, or an
    // earlier incremental injection): never send it twice.
    if (already.has(block)) continue
    if (total + raw.byteLength > cfg.maxTotalBytes) {
      const note = `[${wrapper.omitted}] ${item.rel}`
      if (!already.has(note)) {
        blocks.push(note)
        omittedCount++
      }
      continue
    }
    total += raw.byteLength
    blocks.push(block)
    filePaths.push(item.abs)
    fileCount++
  }

  return { blocks, filePaths, fileCount, missingCount, omittedCount }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderBundle(cfg: Config, bundle: Bundle): string | undefined {
  if (bundle.blocks.length === 0) return undefined
  const content = bundle.blocks.join('\n\n')

  const template = cfg.template.trim()
  if (template.length > 0) {
    const body = template.includes('{{content}}') ? template.replaceAll('{{content}}', content) : `${template}\n\n${content}`
    return `<system-reminder>\n${body}\n</system-reminder>`
  }
  return `<system-reminder>\n${content}\n</system-reminder>`
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

interface SessionLike {
  header?: { cwd?: string }
  surface?: { nodes: ArrayLike<number> }
  eventAt?(seq: number): unknown
}

interface SurfaceEvent {
  type?: string
  data?: { source?: unknown; content?: unknown }
}

/** Every user/message event currently visible on the session surface. */
function surfaceUserMessages(session: SessionLike): SurfaceEvent[] {
  const out: SurfaceEvent[] = []
  try {
    const nodes = session.surface?.nodes
    const eventAt = session.eventAt
    if (!nodes || !eventAt) return out
    for (const seq of Array.from(nodes)) {
      const event = eventAt.call(session, seq) as SurfaceEvent | undefined
      if (event?.type === 'user/message') out.push(event)
    }
  } catch {
    return out
  }
  return out
}

/** Concatenated text of one message event. */
function messageText(event: SurfaceEvent): string {
  const content = event.data?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/* ------------------------------------------------------------------ *
 * Instruction files the host has loaded
 *
 * The host publishes the facts we need in its own `agent-instructions`
 * messages: every change carries a scope key `<dir>\u0000<file>` (the
 * directory is relative to the project root; `user-global` and
 * `agents-global` name the two shared instruction roots), and the
 * baseline message carries the project root. The host loads a project's
 * AGENTS.md mid-session once the agent touches files under it, so this
 * set grows while the session runs — expanding the imports of every
 * file in it is what keeps a project-scoped `@import` reachable.
 * ------------------------------------------------------------------ */

const USER_GLOBAL_SCOPE = 'user-global'
const AGENTS_GLOBAL_SCOPE = 'agents-global'

/** Root of one of the host's two shared instruction directories. */
function userGlobalRoot(scope: string): string {
  if (scope === USER_GLOBAL_SCOPE) {
    return resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  }
  return resolve(process.env.DSH_AGENTS_HOME?.trim() || join(homedir(), '.agents'))
}

function collectLoadedInstructions(
  session: SessionLike,
  cwd: string,
  batch: readonly unknown[] = [],
  inbox: readonly unknown[] = [],
): LoadedInstruction[] {
  let projectRootRel = ''
  const scopes = new Map<string, { dir: string; candidate: string }>()
  const absorb = (source: unknown): void => {
    if (typeof source !== 'object' || source === null) return
    const s = source as {
      kind?: string
      baselineIdentity?: string
      changes?: { scope?: string }[]
    }
    if (s.kind !== 'agent-instructions') return
    if (typeof s.baselineIdentity === 'string') {
      try {
        const identity = JSON.parse(s.baselineIdentity) as { projectRoot?: string }
        if (typeof identity.projectRoot === 'string') projectRootRel = identity.projectRoot
      } catch {
        // malformed identity: keep the previous one
      }
    }
    for (const change of s.changes ?? []) {
      const scope = change?.scope
      if (typeof scope !== 'string') continue
      const separator = scope.indexOf('\u0000')
      if (separator < 0) continue
      scopes.set(scope, {
        dir: scope.slice(0, separator),
        candidate: scope.slice(separator + 1),
      })
    }
  }

  // The host composes a newly loaded instruction file into the CURRENT step's
  // message batch; the durable surface only catches up after that step ends.
  // The host parks the fresh message in the AGENT's inbox until it splices it
  // in, so the inbox is the earliest place the new scope is visible — read
  // all three: inbox (just loaded), batch (this step), surface (earlier).
  for (const message of inbox) {
    absorb((message as { source?: unknown })?.source)
  }
  for (const message of batch) {
    absorb((message as { source?: unknown })?.source)
  }
  for (const message of surfaceUserMessages(session)) {
    absorb(message.data?.source)
  }

  const projectRoot = resolve(cwd, projectRootRel === '' ? '.' : projectRootRel)
  const out: LoadedInstruction[] = []
  const seen = new Set<string>()
  for (const { dir, candidate } of scopes.values()) {
    if (!candidate) continue
    const abs =
      dir === USER_GLOBAL_SCOPE || dir === AGENTS_GLOBAL_SCOPE
        ? resolve(userGlobalRoot(dir), candidate)
        : resolve(projectRoot, dir === '.' ? '' : dir, candidate)
    const key = abs.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ abs, rel: relative(projectRoot, abs) })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Rendered-block bookkeeping
 *
 * A previous injection is the record of what the model already saw. The
 * surface copy of our own messages is that record, so re-deriving the
 * same blocks and comparing them keeps a file from being injected
 * twice — across steps, across processes, and for the incremental
 * injections that follow a mid-session instruction load.
 * ------------------------------------------------------------------ */

const FILE_BLOCK_RE = /<file path="[^"]*">\r?\n[\s\S]*?\r?\n<\/file>/g
const NOTE_LINE_RE = /^\[[^\]\n]+\]\s+\S.*$/gm

function extractRenderedBlocks(text: string): string[] {
  const blocks: string[] = []
  for (const file of text.match(FILE_BLOCK_RE) ?? []) blocks.push(file)
  // Status lines live outside the <file> elements; strip those first so a
  // truncation note inside a block is not mistaken for a standalone line.
  const rest = text.replace(FILE_BLOCK_RE, '\n')
  for (const note of rest.match(NOTE_LINE_RE) ?? []) blocks.push(note.trim())
  return blocks
}

/** Blocks this plugin already injected into the session's visible surface. */
function injectedBlockKeys(session: SessionLike): Set<string> {
  const keys = new Set<string>()
  for (const message of surfaceUserMessages(session)) {
    if (!isOursSource(message.data?.source)) continue
    for (const block of extractRenderedBlocks(messageText(message))) keys.add(block)
  }
  return keys
}

/**
 * Process-local ledger of injected blocks. Only consulted when the surface
 * cannot answer (unreadable); the surface is authoritative otherwise, so a
 * ledger entry whose block a compaction removed never blocks a re-seed.
 */
const injectedLedger = new WeakMap<object, Set<string>>()

function ledgerBlocks(session: SessionLike): Set<string> {
  return injectedLedger.get(session as object) ?? new Set<string>()
}

function rememberBlocks(session: SessionLike, blocks: string[]): void {
  const key = session as object
  let ledger = injectedLedger.get(key)
  if (ledger === undefined) {
    ledger = new Set<string>()
    injectedLedger.set(key, ledger)
  }
  for (const block of blocks) ledger.add(block)
}

/** True for our own message sources: 0.2.0+ kind plus the legacy 0.1.x shape. */
function isOursSource(src: unknown): boolean {
  if (typeof src !== 'object' || src === null) return false
  const s = src as { kind?: string; plugin?: string }
  return s.kind === 'context-imports' || (s.kind === 'plugin' && s.plugin === name)
}

/**
 * Whether one of our injections is visible on the session's live surface.
 *
 * `decision.messages` in pre-step is only this step's admitted batch — it
 * does NOT contain history, so counting there can never answer "already
 * injected". The durable surface is the right source: an injection visible
 * on it means the model sees it; a block compaction replaced out of the
 * surface no longer counts and re-seeding is allowed again.
 *
 * Tri-state because an unreadable surface must not be confused with an
 * empty one: 'unknown' keeps the process ledger as fallback, 'absent'
 * overrides it.
 */
function surfaceInjectionState(session: SessionLike): 'visible' | 'absent' | 'unknown' {
  try {
    const nodes = session.surface?.nodes
    const eventAt = session.eventAt
    if (!nodes || !eventAt) return 'unknown'
    for (const seq of Array.from(nodes)) {
      const event = eventAt.call(session, seq) as
        | { type?: string; data?: { source?: unknown } }
        | undefined
      if (event?.type !== 'user/message') continue
      if (isOursSource(event.data?.source)) return 'visible'
    }
    return 'absent'
  } catch {
    return 'unknown' // unreadable surface: the ledger decides
  }
}

/**
 * Normalize the resolved entry config. Every field is `.volatile()` (required
 * for the settings page to mount), and since DSH 0.2.0-rc.2 the volatile
 * projection NO LONGER fills schema defaults into the entry value — every
 * field can arrive undefined (verified 0.2.0-rc.2: `cfg.files is not
 * iterable` / `entry.injectOn.includes is not a function`). Normalize each
 * field to its declared type with the schema default as fallback.
 */
function normalizeConfig(entry: Config): Config {
  // Volatile fields arrive as { get(), write() } live references (cosmokit
  // protocol). Unwrap before use; plain values pass straight through.
  const unwrap = (v: unknown): unknown =>
    v !== null && typeof v === 'object' && typeof (v as { get?: unknown }).get === 'function'
      ? (v as { get: () => unknown }).get()
      : v
  const e = entry as Partial<Config>
  const strList = (v: unknown, fallback: string[]): string[] => {
    const raw = unwrap(v)
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
    if (typeof raw === 'string') return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    return fallback
  }
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof unwrap(v) === 'boolean' ? (unwrap(v) as boolean) : fallback
  const num = (v: unknown, fallback: number): number => {
    const n = unwrap(v)
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    files: strList(e.files, []),
    scanImports: bool(e.scanImports, true),
    instructionFiles: strList(e.instructionFiles, ['AGENTS.md', 'CLAUDE.md']),
    expandLoadedInstructions: bool(e.expandLoadedInstructions, true),
    maxDepth: num(e.maxDepth, 3),
    maxFileBytes: num(e.maxFileBytes, 64 * 1024),
    maxTotalBytes: num(e.maxTotalBytes, 128 * 1024),
    injectOn: strList(e.injectOn, [...SOURCES]).filter((s) => (SOURCES as readonly string[]).includes(s)),
    liveMode: (() => {
      const v = unwrap(e.liveMode)
      return v === 'inject' || v === 'inject+wake' || v === 'off' ? v : 'off'
    })(),
    watchDebounceMs: num(e.watchDebounceMs, 30_000),
    minReinjectIntervalMs: num(e.minReinjectIntervalMs, 300_000),
    template: typeof unwrap(e.template) === 'string' ? (unwrap(e.template) as string) : '',
    detectedLocale: typeof unwrap(e.detectedLocale) === 'string' ? (unwrap(e.detectedLocale) as string) : '',
  }
}

export function apply(ctx: Context, entry: Config): void {
  // 0.1.7+: the loader owns configuration. The entry config IS the resolved
  // value — user edits ride the profile patch, which reloads this fiber with
  // the updated config. No installSection, no settings thunk.
  const cfg = normalizeConfig(entry)

  // Which creation scene fired last, per session. `agent/pre-step` has no
  // scene concept, so the `agent/created` listener records it and the
  // pre-step listener consults it against `injectOn`. Sessions WITHOUT any
  // recorded scene (long-lived sessions that never saw a creation event in
  // this process — model switches, sessions created before the plugin
  // activated) default to ALLOWED: they get seeded exactly once.
  const lastScene = new WeakMap<object, string>()

  // --- Live mode state (all strong references cleaned on dispose) ---
  /** session → absolute paths injected into it (lower-cased keys). */
  const sessionFiles = new WeakMap<object, Set<string>>()
  /** absolute path (lower-cased) → last re-injection time. */
  const lastInjectAt = new Map<string, number>()
  /** absolute path (lower-cased) → fs watcher. */
  const watchers = new Map<string, import('node:fs').FSWatcher>()
  /** live agents that may be woken on a watched-file change. */
  const wakeTargets = new Set<{ agent: { session: object; followup?: (message: unknown) => void }; session: object }>()
  /** absolute path (lower-cased) → sessions that have it injected. */
  const watchersByPath = new Map<string, Set<object>>()

  const stopWatchIfUnused = (key: string): void => {
    const sessions = watchersByPath.get(key)
    if (sessions === undefined || sessions.size === 0) {
      watchers.get(key)?.close()
      watchers.delete(key)
      watchersByPath.delete(key)
    }
  }

  const ensureWatch = (session: object, abs: string): void => {
    const key = abs.toLowerCase()
    let sessions = watchersByPath.get(key)
    if (sessions === undefined) {
      sessions = new Set()
      watchersByPath.set(key, sessions)
    }
    sessions.add(session)
    if (watchers.has(key)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let watcher: import('node:fs').FSWatcher
    try {
      watcher = fsWatchSync(abs, { persistent: false }, () => {
        // Debounce: editors on Windows often fire two events per save.
        if (timer !== undefined) return
        timer = setTimeout(() => {
          timer = undefined
          onMaybeChanged(abs)
        }, cfg.watchDebounceMs)
        timer.unref?.()
      })
    } catch {
      // File vanished between listing and watching: not fatal, the next
      // injection round re-reports it as missing.
      return
    }
    watcher.on('error', () => {
      /* watched file deleted/renamed: keep or drop silently */
    })
    watchers.set(key, watcher)
  }

  const onMaybeChanged = (abs: string): void => {
    if (cfg.liveMode === 'off') return
    const key = abs.toLowerCase()
    const now = Date.now()
    if (now - (lastInjectAt.get(key) ?? 0) < cfg.minReinjectIntervalMs) {
      return
    }
    lastInjectAt.set(key, now)
    for (const target of wakeTargets) {
      if (!sessionFiles.get(target.session)?.has(key)) continue
      if (cfg.liveMode === 'inject+wake') {
        // Wake turn: `followup(message)` queues an ordinary turn and wakes the
        // idle driver. The wake message uses its OWN source kind (not
        // `context-imports`) so the pre-step inBatch guard does not mistake
        // the wake turn for an already-injected step. The changed file is
        // injected by the regular gate inside that turn.
        try {
          target.agent.followup?.(
            createUserMessage({
              content: [
                {
                  type: 'text',
                  text:
                    `[dsh-context-imports] live update: an instruction-referenced file changed on disk ` +
                    `(${abs}). Its latest content is injected in this turn; treat the disk version as current.`,
                },
              ],
              source: { kind: 'context-imports-wake', form: 'wake' },
            }),
          )
        } catch (error) {
          ctx.logger.warn('dsh-context-imports: wake failed: %o', error)
        }
      }
      // 'inject' mode: no wake — the regular gate picks the change up on the
      // next interaction.
    }
  }

  // Watcher lifecycle: closed when this fiber unloads (patch edit, plugin
  // disable, host shutdown).
  ctx.effect(() => {
    return () => {
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
      watchersByPath.clear()
      wakeTargets.clear()
    }
  }, 'dsh-context-imports: live watchers')

  ctx.on('agent/created', (payload): undefined => {
    const scene = SOURCES.includes(payload.source as (typeof SOURCES)[number]) ? payload.source : undefined
    if (scene === undefined) return undefined
    // Belt and braces: if a compact scene ever fires, drop the ledger so the
    // surface scan alone decides whether a re-seed is due. In-place
    // compaction (the 0.2.0 /compact path) never re-announces the agent, so
    // the pre-step gate treats a surface-absent ledger entry as stale anyway.
    if (scene === 'compact') injectedLedger.delete(payload.agent.session)
    const allowed = cfg.injectOn.includes(scene)
    lastScene.set(payload.agent.session, allowed ? scene : 'suppressed')
    if (cfg.liveMode !== 'off' && allowed) {
      wakeTargets.add({
        agent: payload.agent as unknown as { session: object; followup?: (message: unknown) => void },
        session: payload.agent.session as object,
      })
    }
    return undefined
  })

  ctx.on('agent/disposed', (payload): undefined => {
    const session = (payload as { agent?: { session?: object }; session?: object }).agent?.session ?? (payload as { session?: object }).session
    if (session === undefined) return undefined
    wakeTargets.forEach((target) => {
      if (target.session === session) wakeTargets.delete(target)
    })
    const injectedPaths = sessionFiles.get(session)
    if (injectedPaths !== undefined) {
      for (const key of injectedPaths) stopWatchIfUnused(key)
      sessionFiles.delete(session)
    }
    return undefined
  })

  // At most one copy of each file per session, and never a file the model
  // already has. The durable surface is the authority: it holds the blocks
  // we injected before, so a file already in the model's context is skipped
  // (across steps, across processes, and across the incremental injections
  // that follow a mid-session instruction load). The process ledger only
  // answers when the surface cannot be read.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const session = agent.session as SessionLike
    const inboxNextStep = (agent as { inbox?: { nextStep?: readonly unknown[] } }).inbox?.nextStep ?? []
    const inBatch = decision.messages.some((m) => isOursSource((m as { source?: unknown }).source))
    if (inBatch) return decision

    // No recorded scene (fiber reloaded after a hot swap, or the agent was
    // created before this plugin activated): treat as startup so long-lived
    // sessions still get seeded — the surface dedup below keeps it to one copy.
    const scene = lastScene.get(session) ?? 'startup'
    if (scene === 'suppressed' || !cfg.injectOn.includes(scene)) return decision
    try {
      signal.throwIfAborted()
      const cwd = session.header?.cwd ?? process.cwd()
      const surface = surfaceInjectionState(session)
      const already = surface === 'unknown' ? ledgerBlocks(session) : injectedBlockKeys(session)
      // Wrapper language follows the browser-resolved locale synced into our
      // own config by the client half; final fallback English.
      const wrapper = wrapperFor(cfg.detectedLocale || undefined)
      const loaded = cfg.expandLoadedInstructions
        ? collectLoadedInstructions(session, cwd, decision.messages, inboxNextStep)
        : []
      const bundle = await collectBundle(cfg, cwd, loaded, already, wrapper)
      const text = renderBundle(cfg, bundle)
      if (text === undefined) return decision
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'context-imports', form: 'instructions' },
      })
      // Placement: append to the END of the step's message list — the same
      // position the stock skill-catalog uses. Context injections from
      // outer waterfall listeners (agent-instructions baseline, skill
      // catalog, …) join AFTER our inner pass, so only the tail is
      // guaranteed to sit behind all of them. The model reads our expanded
      // files last, right after the instructions that reference them.
      rememberBlocks(session, bundle.blocks)
      if (cfg.liveMode !== 'off') {
        const set = sessionFiles.get(session) ?? new Set<string>()
        for (const abs of bundle.filePaths) {
          set.add(abs.toLowerCase())
          ensureWatch(session as object, abs)
          lastInjectAt.set(abs.toLowerCase(), Date.now())
        }
        sessionFiles.set(session, set)
        if (cfg.liveMode === 'inject+wake') {
          wakeTargets.add({
            agent: agent as unknown as { session: object; followup?: (message: unknown) => void },
            session: session as object,
          })
        }
      }
      ctx.logger.info('dsh-context-imports: injected %d file(s), %d missing, %d omitted (scene=%s)',
        bundle.fileCount, bundle.missingCount, bundle.omittedCount, scene)
      return {
        ...decision,
        messages: [...decision.messages, message],
      }
    } catch (error) {
      ctx.logger.warn('dsh-context-imports: injection failed: %o', error)
      return decision
    }
  })
}
