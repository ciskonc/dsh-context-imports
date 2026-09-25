/**
 * dsh-context-imports — host half.
 *
 * Expands Claude Code-style `@path` imports found in workspace instruction
 * files (AGENTS.md / CLAUDE.md) and injects the referenced files into model
 * context at session start, via the official `agent/session-start` event and
 * `agent.inject()` channel. Optionally merges an explicit `files` list.
 *
 * Official API surface only: cordis events, dsh-llm createUserMessage,
 * schemastery Config, dsh-settings installSection (optional service).
 */
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent' // pulls the cordis Events augmentation (agent/session-start typing)
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-context-imports'

/** Settings namespace shared with the client settings card. */
const NS = 'dsh-context-imports'

const SOURCES = ['startup', 'resume', 'clear', 'compact'] as const

export interface Config {
  /** Extra files to inject (relative to session cwd, or absolute). */
  files: string[]
  /** Scan instruction files for `@path` imports and expand them recursively. */
  scanImports: boolean
  /** Instruction file candidates to scan (content NOT re-injected: the stock agent-instructions plugin owns them). */
  instructionFiles: string[]
  /** Maximum @import recursion depth. */
  maxDepth: number
  /** Per-file byte cap. */
  maxFileBytes: number
  /** Total injection byte cap. */
  maxTotalBytes: number
  /** Session-start sources that trigger injection. */
  injectOn: string[]
  /** Custom wrapper template with {{content}} placeholder; empty = locale default. */
  template: string
  /** Auto-written by the client half: the browser-resolved UI language. Lets the host follow the UI locale when the user has no explicit locale preference. */
  detectedLocale: string
}

export const Config = z.object({
  files: z.array(z.string()).default([]),
  scanImports: z.boolean().default(true),
  instructionFiles: z.array(z.string()).default(['AGENTS.md', 'CLAUDE.md']),
  maxDepth: z.number().default(3),
  maxFileBytes: z.number().default(64 * 1024),
  maxTotalBytes: z.number().default(128 * 1024),
  injectOn: z.array(z.string()).default([...SOURCES]),
  template: z.string().default(''),
  detectedLocale: z.string().default(''),
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

interface Section {
  path: string
  content: string
  truncatedAt?: number
}

interface Bundle {
  sections: Section[]
  missing: string[]
  omitted: string[]
}

interface QueueItem {
  abs: string
  rel: string
  depth: number
  /** Instruction files are scanned for imports but their content is not re-injected. */
  scanOnly: boolean
}

async function collectBundle(cfg: Config, cwd: string): Promise<Bundle> {
  const seen = new Set<string>()
  const queue: QueueItem[] = []
  const sections: Section[] = []
  const missing: string[] = []
  const omitted: string[] = []
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
    for (const f of cfg.instructionFiles) {
      enqueue(resolve(cwd, f), f, 0, true)
    }
  }

  while (queue.length > 0) {
    const item = queue.shift()!
    let raw: Buffer
    try {
      raw = await readFile(item.abs)
    } catch {
      if (!item.scanOnly) missing.push(item.rel)
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
    if (total + raw.byteLength > cfg.maxTotalBytes) {
      omitted.push(item.rel)
      continue
    }
    total += raw.byteLength
    sections.push({ path: item.rel, content: text, truncatedAt })
  }

  return { sections, missing, omitted }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderBundle(cfg: Config, bundle: Bundle, wrapper: Wrapper): string | undefined {
  if (bundle.sections.length === 0 && bundle.missing.length === 0) return undefined

  const parts: string[] = []
  for (const s of bundle.sections) {
    const note = s.truncatedAt !== undefined ? `\n[${wrapper.truncated} ${s.truncatedAt} bytes]` : ''
    parts.push(`<file path="${s.path}">\n${s.content}${note}\n</file>`)
  }
  for (const m of bundle.missing) parts.push(`[${wrapper.missing}] ${m}`)
  for (const o of bundle.omitted) parts.push(`[${wrapper.omitted}] ${o}`)
  const content = parts.join('\n\n')

  const template = cfg.template.trim()
  if (template.length > 0) {
    const body = template.includes('{{content}}') ? template.replaceAll('{{content}}', content) : `${template}\n\n${content}`
    return `<system-reminder>\n${body}\n</system-reminder>`
  }
  return `<system-reminder>\n${content}\n</system-reminder>`
}

/* ------------------------------------------------------------------ *
 * Settings integration (optional service — plugin works without it)
 * ------------------------------------------------------------------ */

interface SettingsLike {
  installSection(owner: unknown, ns: string, schema: unknown, entry: unknown, hooks: {
    setSource(current: () => Config): void
    onChange(): void
  }): void
  get(ns: string): unknown
}

interface Injectable {
  inject(deps: string[], callback: (ctx: { settings: SettingsLike }) => void): void
  get(name: string): unknown
}

function readLocalePreference(ctx: Context): string | undefined {
  try {
    const settings = (ctx as unknown as Injectable).get('settings') as SettingsLike | undefined
    const value = settings?.get('locale') as { preference?: string } | undefined
    return value?.preference
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx: Context, entry: Config): void {
  // The settings thunk returns the currently authoritative value (composition
  // entry + user overrides); evaluating it lazily at each injection picks up
  // settings-card edits without a reload.
  let sourceOf: () => Config = () => entry

  // Optional settings integration: register our namespace so the web
  // settings card (client half) can edit this configuration at runtime.
  try {
    ;(ctx as unknown as Injectable).inject(['settings'], (c) => {
      c.settings.installSection(ctx, NS, Config, entry, {
        setSource: (get) => {
          sourceOf = get
        },
        onChange: () => {},
      })
    })
  } catch {
    // No settings service in this profile: run on composition config only.
  }

  // Which session-start scene fired last, per session. `agent/pre-step` has no
  // scene concept, so the session-start listener records it and the pre-step
  // listener consults it against `injectOn`. Sessions WITHOUT any recorded
  // scene (long-lived sessions that never saw a session-start in this
  // process — model switches, sessions created before the plugin activated)
  // default to ALLOWED: the single-injection invariant is the only gate, so
  // they get seeded exactly once on their next step.
  const lastScene = new WeakMap<object, string>()

  ctx.on('agent/session-start', (payload) => {
    const scene = SOURCES.includes(payload.source as (typeof SOURCES)[number]) ? payload.source : undefined
    if (scene === undefined) return
    const allowed = sourceOf().injectOn.includes(scene)
    lastScene.set(payload.agent.session, allowed ? scene : 'suppressed')
  })

  // Converge to EXACTLY ONE injection per request, using the official
  // skill-catalog replacement pattern: `decision.messages` is the complete
  // request sequence (history surface + this step's admitted messages), so
  // counting our messages there covers every case —
  //   zero  → scene-gated append (fresh session, compaction cleared the old
  //           block, never-injected active session, model switch, …)
  //   one   → leave as is
  //   many  → drop the stale ones, keep the newest (history redundancy from
  //           older versions converges here too)
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const session = agent.session
    const mine: number[] = []
    for (let i = 0; i < decision.messages.length; i++) {
      const src = (decision.messages[i] as { source?: { kind?: string; plugin?: string } }).source
      if (src?.kind === 'plugin' && src?.plugin === name) mine.push(i)
    }
    if (mine.length > 1) {
      const drop = new Set(mine.slice(0, -1))
      ctx.logger.info('dsh-context-imports: converged %d stale injections to one', mine.length)
      return { ...decision, messages: decision.messages.filter((_, i) => !drop.has(i)) }
    }
    if (mine.length === 1) return decision

    const scene = lastScene.get(session) ?? 'active-session'
    const cfg = sourceOf()
    if (scene === 'suppressed' || !cfg.injectOn.includes(scene)) return decision
    try {
      signal.throwIfAborted()
      const cwd = session.header?.cwd ?? process.cwd()
      const bundle = await collectBundle(cfg, cwd)
      // Explicit UI locale preference wins; otherwise follow the browser-resolved
      // language synced by the client half; final fallback English.
      const wrapper = wrapperFor(readLocalePreference(ctx) ?? (cfg.detectedLocale || undefined))
      const text = renderBundle(cfg, bundle, wrapper)
      if (text === undefined) return decision
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'instructions' },
      })
      // Placement: append to the END of the step's message list — the same
      // position the stock skill-catalog uses. Context injections from
      // outer waterfall listeners (agent-instructions baseline, skill
      // catalog, …) join AFTER our inner pass, so only the tail is
      // guaranteed to sit behind all of them. The model reads our expanded
      // files last, right after the instructions that reference them.
      ctx.logger.info('dsh-context-imports: injected %d file(s), %d missing, %d omitted (scene=%s)',
        bundle.sections.length, bundle.missing.length, bundle.omitted.length, scene)
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
