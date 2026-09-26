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
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
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

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-imports': ContextImportsSource
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
 * Plugin entry
 * ------------------------------------------------------------------ */

interface SessionLike {
  header?: { cwd?: string }
  surface?: { nodes: ArrayLike<number> }
  eventAt?(seq: number): unknown
}

/** Sessions this process already injected into (guards the pre-persist window). */
const injectedSessions = new WeakSet<object>()

/** True for our own message sources: 0.2.0+ kind plus the legacy 0.1.x shape. */
function isOursSource(src: unknown): boolean {
  if (typeof src !== 'object' || src === null) return false
  const s = src as { kind?: string; plugin?: string }
  return s.kind === 'context-imports' || (s.kind === 'plugin' && s.plugin === name)
}

/**
 * True when one of our injections is visible on the session's live surface.
 *
 * `decision.messages` in pre-step is only this step's admitted batch — it
 * does NOT contain history, so counting there can never answer "already
 * injected". The durable surface is the right source: an injection visible
 * on it means the model sees it; a block compaction replaced out of the
 * surface no longer counts and re-seeding is allowed again.
 */
function hasVisibleInjection(session: SessionLike): boolean {
  try {
    const nodes = session.surface?.nodes
    const eventAt = session.eventAt
    if (!nodes || !eventAt) return false
    for (const seq of Array.from(nodes)) {
      const event = eventAt.call(session, seq) as
        | { type?: string; data?: { source?: unknown } }
        | undefined
      if (event?.type !== 'user/message') continue
      if (isOursSource(event.data?.source)) return true
    }
  } catch {
    return false // unreadable surface: prefer injecting over losing context
  }
  return false
}

export function apply(ctx: Context, entry: Config): void {
  // 0.1.7+: the loader owns configuration. The entry config IS the resolved
  // value — user edits ride the profile patch, which reloads this fiber with
  // the updated config. No installSection, no settings thunk.

  // Which creation scene fired last, per session. `agent/pre-step` has no
  // scene concept, so the `agent/created` listener records it and the
  // pre-step listener consults it against `injectOn`. Sessions WITHOUT any
  // recorded scene (long-lived sessions that never saw a creation event in
  // this process — model switches, sessions created before the plugin
  // activated) default to ALLOWED: they get seeded exactly once.
  const lastScene = new WeakMap<object, string>()

  ctx.on('agent/created', (payload): undefined => {
    const scene = SOURCES.includes(payload.source as (typeof SOURCES)[number]) ? payload.source : undefined
    if (scene === undefined) return undefined
    // Compaction cleared the ledger so the surface scan alone decides
    // whether a re-seed is due (block gone → inject, still visible → skip).
    if (scene === 'compact') injectedSessions.delete(payload.agent.session)
    const allowed = entry.injectOn.includes(scene)
    lastScene.set(payload.agent.session, allowed ? scene : 'suppressed')
    return undefined
  })

  // At most one injection per session's visible history. Three guards,
  // cheapest first: this step's batch (in case another path already added
  // one), the process-local ledger (pre-persist window), and the durable
  // surface scan (the authoritative cross-process answer).
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const session = agent.session as SessionLike
    const inBatch = decision.messages.some((m) => isOursSource((m as { source?: unknown }).source))
    if (inBatch || injectedSessions.has(session) || hasVisibleInjection(session)) return decision

    const scene = lastScene.get(session) ?? 'active-session'
    if (scene === 'suppressed' || !entry.injectOn.includes(scene)) return decision
    try {
      signal.throwIfAborted()
      const cwd = session.header?.cwd ?? process.cwd()
      const bundle = await collectBundle(entry, cwd)
      // Wrapper language follows the browser-resolved locale synced into our
      // own config by the client half; final fallback English.
      const wrapper = wrapperFor(entry.detectedLocale || undefined)
      const text = renderBundle(entry, bundle, wrapper)
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
      injectedSessions.add(session)
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
