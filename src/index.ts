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
 * Locale wrappers (model-facing). The host has no official i18n API,
 * so we keep a small dictionary here and follow the UI locale
 * preference stored in the official `locale` settings namespace.
 * ------------------------------------------------------------------ */

interface Wrapper {
  intro: string
  truncated: string
  missing: string
  omitted: string
}

const WRAPPERS: Record<string, Wrapper> = {
  en: {
    intro: 'The following workspace files were referenced via @imports (or explicitly configured) and are injected at session start by dsh-context-imports. Treat them as durable context for this session.',
    truncated: 'truncated at',
    missing: 'referenced but not found',
    omitted: 'omitted: total byte budget reached',
  },
  zh: {
    intro: '以下工作区文件由 dsh-context-imports 在会话启动时注入（来自 @import 引用或显式配置），请将其作为本会话的持久上下文对待。',
    truncated: '已截断于',
    missing: '被引用但文件不存在',
    omitted: '已省略：超出总字节预算',
  },
  ja: {
    intro: '以下のワークスペースファイルは dsh-context-imports によりセッション開始時に注入されました（@import 参照または明示的な設定より）。このセッションの永続コンテキストとして扱ってください。',
    truncated: 'バイト数で切り詰め:',
    missing: '参照されていますが見つかりません',
    omitted: '省略: 合計バイト予算に達しました',
  },
  fr: {
    intro: 'Les fichiers d’espace de travail suivants ont été injectés au démarrage de la session par dsh-context-imports (références @imports ou configuration explicite). Traitez-les comme un contexte durable pour cette session.',
    truncated: 'tronqué à',
    missing: 'référencé mais introuvable',
    omitted: 'omis : budget total d’octets atteint',
  },
  ru: {
    intro: 'Следующие файлы рабочей области внедрены при старте сессии плагином dsh-context-imports (ссылки @imports или явная настройка). Считайте их постоянным контекстом этой сессии.',
    truncated: 'обрезано на',
    missing: 'указан, но не найден',
    omitted: 'пропущено: достигнут общий лимит байт',
  },
  ko: {
    intro: '다음 워크스페이스 파일들은 dsh-context-imports에 의해 세션 시작 시 주입되었습니다(@import 참조 또는 명시적 설정). 이 세션의 영구 컨텍스트로 취급하세요.',
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
  return `<system-reminder>\n${wrapper.intro}\n\n${content}\n</system-reminder>`
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

interface AgentLike {
  inject(message: unknown): void
  session: {
    header?: { cwd?: string }
    /** Official dsh-session API: full-log snapshot + cursor. */
    snapshotEvents?(from?: number, to?: number): readonly unknown[]
    seq?: number
    surface?: { nodes: ArrayLike<number> }
    eventAt?(seq: number): unknown
  }
}

/** Sessions this process already injected into (guards the pre-persist window). */
const injectedSessions = new WeakSet<object>()

/** Fingerprints unique to our injected messages, regardless of event shape. */
const FINGERPRINTS = [
  '"plugin":"dsh-context-imports"',
  'injected at session start by dsh-context-imports',
  '由 dsh-context-imports 在会话启动时注入',
]

/**
 * True when the durable log already carries one of our injections.
 *
 * Verified against a live session log: injected messages persist as
 * `agent/inbox/spliced` events (source inside `data.inserted[]`) — they are
 * NOT surface events, so `surface.nodes` never sees them. Scan the full log
 * through the official `snapshotEvents()` instead, pre-filtered by event type
 * to keep the stringify cost bounded.
 */
function hasExistingInjection(agent: AgentLike): boolean {
  try {
    const session = agent.session
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents.call(session)
      for (const event of events) {
        const type = (event as { type?: string } | undefined)?.type
        if (type !== 'agent/inbox/spliced' && type !== 'user/message') continue
        let raw: string
        try {
          raw = JSON.stringify(event)
        } catch {
          continue
        }
        if (!raw.includes('dsh-context-imports')) continue
        if (FINGERPRINTS.some((f) => raw.includes(f))) return true
      }
      return false
    }
  } catch {
    // fall through to the legacy surface scan
  }
  try {
    // Legacy fallback: surface scan (cannot see inbox events; better than nothing).
    const nodes = agent.session.surface?.nodes
    const eventAt = agent.session.eventAt
    if (!nodes || !eventAt) return false
    for (const seq of Array.from(nodes).toReversed()) {
      let raw: string
      try {
        raw = JSON.stringify(eventAt.call(agent.session, seq))
      } catch {
        continue
      }
      if (raw.includes('dsh-context-imports') && FINGERPRINTS.some((f) => raw.includes(f))) return true
    }
  } catch {
    return false // unreadable history: prefer injecting over losing context
  }
  return false
}

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

  ctx.on('agent/session-start', async (payload: { agent: AgentLike; source: string }) => {
    const cfg = sourceOf()
    const source = SOURCES.includes(payload.source as (typeof SOURCES)[number]) ? payload.source : undefined
    if (source === undefined || !cfg.injectOn.includes(source)) return
    // Single invariant: at most one injection alive in the active history.
    // Process-local ledger guards the window before the first message is
    // persisted; compaction clears it so the history scan alone decides —
    // old block still present → skip, removed by compaction → re-inject.
    if (source === 'compact') injectedSessions.delete(payload.agent.session)
    if (injectedSessions.has(payload.agent.session) || hasExistingInjection(payload.agent)) {
      ctx.logger.info('dsh-context-imports: existing injection found, skipped (source=%s)', source)
      return
    }
    try {
      const cwd = payload.agent.session.header?.cwd ?? process.cwd()
      const bundle = await collectBundle(cfg, cwd)
      // Explicit UI locale preference wins; otherwise follow the browser-resolved
      // language synced by the client half; final fallback English.
      const wrapper = wrapperFor(readLocalePreference(ctx) ?? (cfg.detectedLocale || undefined))
      const text = renderBundle(cfg, bundle, wrapper)
      if (text === undefined) return
      payload.agent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'instructions' },
      }))
      injectedSessions.add(payload.agent.session)
      ctx.logger.info('dsh-context-imports: injected %d file(s), %d missing, %d omitted (source=%s)',
        bundle.sections.length, bundle.missing.length, bundle.omitted.length, source)
    } catch (error) {
      ctx.logger.warn('dsh-context-imports: injection failed: %o', error)
    }
  })
}
