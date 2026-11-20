/**
 * dsh-context-imports — adversarial audit harness (dimensions 3 + 4).
 *
 * Dimension 3: malformed / hostile inputs to the import expander.
 * Dimension 4: live watcher edge cases (fs.watch lifecycle).
 *
 * Reuses the mock structure of scripts/robustness.test.mjs (copied, not
 * imported: that file runs its own suite at top level and process.exit()s).
 *
 *   node scripts/audit-malicious.test.mjs
 *   node --test scripts/audit-malicious.test.mjs   (same result; file-level pass/fail)
 *
 * Verdict conventions inside assertions:
 *   - An assertion encodes the *documented expected behaviour*; a FAIL means
 *     the plugin did something else (crash / wrong output / silent error).
 *   - Some behaviours are "known behaviour" rather than bugs: the assertion
 *     pins them so a future change is noticed; the audit report grades them
 *     PASS / FAIL / RISK separately from the test verdict.
 */
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, unlinkSync, renameSync, symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const modulePath = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(modulePath)

let passed = 0
let failed = 0
let skipped = 0

async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

function skip(name, reason) {
  skipped++
  console.log(`  SKIP  ${name}\n        ${reason}`)
}

/** Hard wall against a runaway expander: a real infinite loop hangs the whole
 * process, so the timeout path records the case and hard-exits. */
async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms (${label}) — possible infinite loop`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * Mock host (same shape as robustness.test.mjs)
 * ------------------------------------------------------------------ */

/** Temp dir with an arbitrary file map; values are string or Buffer. */
function makeDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-audit-'))
  for (const [name, content] of Object.entries(files)) {
    const p = join(root, name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  return root
}

function userMessage(source, text) {
  return { type: 'user/message', data: { source, content: [{ type: 'text', text }] } }
}

function makeSession(cwd, surfaceMessages = []) {
  const events = new Map()
  const nodes = []
  surfaceMessages.forEach((message, index) => {
    const seq = index + 1
    events.set(seq, message)
    nodes.push(seq)
  })
  return {
    header: { cwd },
    surface: { nodes },
    eventAt(seq) {
      return events.get(seq)
    },
  }
}

function makeCtx() {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
  }
  return { ctx, listeners, disposers }
}

async function stepOn(listeners, agent, decision = { kind: 'continue', messages: [] }) {
  const preStep = listeners.get('agent/pre-step')
  if (!preStep) return decision
  return preStep({ agent, signal: new AbortController().signal }, async () => decision)
}

/** One-shot fiber: apply() + agent/created + one pre-step. */
async function runPlugin({ entry, session, scene = 'startup', captureFollowup }) {
  const { ctx, listeners } = makeCtx()
  apply(ctx, entry)
  const created = listeners.get('agent/created')
  if (created) created({ source: scene, agent: { session, id: 'agent-1' } })
  const agent = {
    session,
    id: 'agent-1',
    inbox: { nextStep: [] },
    followup: captureFollowup ? (message) => captureFollowup(message) : undefined,
  }
  const result = await withTimeout(stepOn(listeners, agent), 8000, 'pre-step')
  const messages = (result?.messages ?? []).filter((m) => m?.source?.kind === 'context-imports')
  const injected = messages.map((m) => (m.content ?? []).map((p) => p.text ?? '').join('\n'))
  return { injected, result }
}

const defaultEntry = {
  files: [],
  scanImports: true,
  instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
  expandLoadedInstructions: true,
  maxDepth: 3,
  maxFileBytes: 65536,
  maxTotalBytes: 131072,
  injectOn: ['startup', 'resume', 'clear', 'compact'],
  template: '',
  detectedLocale: 'en',
}

const liveEntry = (over = {}) => ({
  ...defaultEntry,
  liveMode: 'inject+wake',
  watchDebounceMs: 50,
  minReinjectIntervalMs: 1000,
  ...over,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ================================================================== *
 * Dimension 3 — malformed / hostile inputs
 * ================================================================== */

console.log('\n[D3-01] circular references')

await check('D3-01a two-file cycle A@B B@A terminates, each file once', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@a.md\n',
    'a.md': '# a\n\n@b.md\n',
    'b.md': '# b\n\n@a.md\n',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1, `expected exactly one injection message, got ${injected.length}`)
  const occurrences = injected[0].split('<file path=').length - 1
  assert.equal(occurrences, 2, `expected a.md and b.md once each, got ${occurrences} file blocks`)
  assert.match(injected[0], /# a/)
  assert.match(injected[0], /# b/)
})

await check('D3-01b self-reference A@A terminates with a single copy', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@a.md\n',
    'a.md': '# a\n\n@a.md\n',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  const occurrences = injected[0].split('<file path=').length - 1
  assert.equal(occurrences, 1, `self-referencing a.md must appear once, got ${occurrences}`)
})

await check('D3-01c 5-deep cycle chain a1..a5 -> a1 terminates (maxDepth=5)', async () => {
  const files = { 'AGENTS.md': '# root\n\n@a1.md\n' }
  for (let i = 1; i <= 5; i++) {
    const next = i === 5 ? 'a1.md' : `a${i + 1}.md`
    files[`a${i}.md`] = `# a${i}\n\n@${next}\n`
  }
  const root = makeDir(files)
  const { injected } = await runPlugin({ entry: { ...defaultEntry, maxDepth: 5 }, session: makeSession(root) })
  assert.equal(injected.length, 1)
  const occurrences = injected[0].split('<file path=').length - 1
  assert.equal(occurrences, 5, `expected 5 files each once, got ${occurrences}`)
  // Known behaviour (observed, not failed): with the DEFAULT maxDepth=3 the
  // chain stops after a3 — a3's @a4 is silently dropped, no note anywhere.
  const shallow = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  const shallowBlocks = shallow.injected[0]?.split('<file path=').length - 1
  console.log(`        [observed] default maxDepth=3 injects ${shallowBlocks} of 5 chain files, silently`)
  assert.ok(shallowBlocks <= 3, `depth cap must bound the chain, got ${shallowBlocks}`)
})

console.log('\n[D3-02] @target is not a readable file')

await check('D3-02a @target is an extension-named directory: missing note, no crash', async () => {
  // The scanner regex requires a file extension, so the directory must be
  // named like a file (adir.md) to even reach the read attempt.
  const root = makeDir({ 'AGENTS.md': '# root\n\n@adir.md\n', 'adir.md/keep.txt': 'x' })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  // EISDIR lands in the same catch as ENOENT: a "not found" note. The wording
  // is misleading (the dir exists) but the behaviour is safe — pinned here.
  assert.equal(injected.length, 1, `expected one injection message carrying the note, got ${JSON.stringify(injected)}`)
  assert.match(injected[0], /referenced but not found/, 'EISDIR should surface as the missing-note')
  assert.match(injected[0], /not found\] adir\.md/, 'note cites the ref without the @ prefix')
})

await check('D3-02a2 @target without extension (a plain dir name): silently ignored', async () => {
  const root = makeDir({ 'AGENTS.md': '# root\n\n@adir\n', 'adir/keep.txt': 'x' })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  // Known behaviour: no extension -> never matches IMPORT_RE -> no note.
  assert.equal(injected.length, 0, 'extension-less ref should be silently ignored')
})

await check('D3-02b @Q:\\foo.md (dead drive): silently ignored by the scanner regex', async () => {
  const root = makeDir({ 'AGENTS.md': '# root\n\n@Q:\\foo.md\n' })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  // IMPORT_RE has no ':' in its char class, so a drive-letter path never even
  // matches. Known behaviour: no note, no injection, no error.
  assert.equal(injected.length, 0, 'drive-letter path should not match the import regex')
})

await check('D3-02c UNC path @\\\\localhost\\c$\\x.md: silently ignored', async () => {
  const root = makeDir({ 'AGENTS.md': '# root\n\n@\\\\localhost\\c$\\x.md\n' })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 0, 'UNC path should not match the import regex')
})

console.log('\n[D3-03] byte budgets')

await check('D3-03a 5MB file with maxFileBytes=64KB truncates with a note', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@big.md\n',
    'big.md': 'A'.repeat(5 * 1024 * 1024),
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /truncated at 65536 bytes/, 'truncation note with the cap value expected')
  const block = injected[0].match(/<file path="[^"]*">\r?\n([\s\S]*?)\r?\n\[truncated/)?.[1] ?? ''
  assert.equal(Buffer.byteLength(block, 'utf8'), 65536, 'injected body must be exactly the cap in bytes')
})

await check('D3-03b total budget exhausted: overflow file gets an omitted note', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@a.md\n@b.md\n',
    'a.md': 'A'.repeat(60000),
    'b.md': 'B'.repeat(60000),
  })
  const { injected } = await runPlugin({ entry: { ...defaultEntry, maxTotalBytes: 100000 }, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /<file path="@a\.md"|<file path="a\.md">|A{1000,}/, 'a.md (fits) injected')
  assert.match(injected[0], /omitted: total byte budget reached\] b\.md/, 'b.md must carry the omitted note')
  assert.doesNotMatch(injected[0], /B{1000,}/, 'b.md content must not be injected')
})

await check('D3-03c file exactly == maxFileBytes: boundary is inclusive (no truncation)', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@exact.md\n',
    'exact.md': 'E'.repeat(65536),
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.doesNotMatch(injected[0], /truncated/, 'byteLength == cap must NOT truncate (strict >)')
  assert.match(injected[0], /E{65536}/, 'full 64KiB body expected')
})

await check('D3-03d file exactly == maxTotalBytes: boundary is inclusive (injected)', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@s.md\n',
    's.md': 'S'.repeat(1000),
  })
  const ok = await runPlugin({ entry: { ...defaultEntry, maxTotalBytes: 1000 }, session: makeSession(root) })
  assert.equal(ok.injected.length, 1, 'total == budget must inject (strict >)')
  const tight = await runPlugin({ entry: { ...defaultEntry, maxTotalBytes: 999 }, session: makeSession(root) })
  assert.equal(tight.injected.length, 1)
  assert.match(tight.injected[0], /omitted/, 'total 1000 > budget 999 must omit with the note')
})

console.log('\n[D3-04] binary / exotic content')

await check('D3-04a NUL bytes inside .md pass through into the message', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@bin.md\n',
    'bin.md': Buffer.from([0x41, 0x00, 0x42, 0x00, 0x0a]),
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1, 'no crash on NUL bytes')
  // Known behaviour: NUL survives utf8 decoding and reaches the model text.
  assert.ok(injected[0].includes('\u0000'), 'NUL byte expected verbatim in the injected block')
  // Dedup still works with NUL inside the block key.
  const surface = [userMessage({ kind: 'context-imports', form: 'instructions' }, injected[0])]
  const second = await runPlugin({ entry: defaultEntry, session: makeSession(root, surface) })
  assert.equal(second.injected.length, 0, 'block with NUL must still dedup')
})

await check('D3-04b pure-emoji file injects; tiny cap yields U+FFFD (explicit files list)', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@emo.md\n',
    'emo.md': '😀😀😀😀',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.ok(injected[0].includes('😀😀😀😀'), 'all four emoji expected intact')

  // Truncation probe via the explicit files list (AGENTS.md stays out of the
  // way — its own 13 bytes would be truncated by a tiny cap too, which is
  // covered separately in D3-04d).
  const cutRoot = makeDir({ 'emo.md': '😀😀' })
  const cut = await runPlugin({
    entry: { ...defaultEntry, maxFileBytes: 2, files: ['emo.md'] },
    session: makeSession(cutRoot),
  })
  assert.equal(cut.injected.length, 1, `explicit-file truncation must still inject, got ${JSON.stringify(cut.injected)}`)
  assert.ok(cut.injected[0].includes('\uFFFD'), 'a cut multibyte char must decode to U+FFFD, not crash')
})

await check('D3-04d cap smaller than the instruction file itself: refs SURVIVE (scanned from full text)', async () => {
  // FIXED BEHAVIOUR: the byte cap still truncates the INJECTED content, but
  // import scanning now reads the untruncated text, so the trailing @ref
  // survives and its file still gets injected.
  const root = makeDir({
    'AGENTS.md': '# root\n\n@a.md\n',
    'a.md': 'SURV\n',
  })
  const { injected } = await runPlugin({ entry: { ...defaultEntry, maxFileBytes: 2 }, session: makeSession(root) })
  const joined = injected.join('\n')
  // maxFileBytes=2 applies to every file, so a.md itself is truncated to
  // "SU" — the point is that the file is PRESENT at all (its import was
  // found in the untruncated scan of AGENTS.md, which is what 0.5.1 lost).
  assert.ok(joined.includes('a.md'), `imported file must appear despite its host being truncated; got ${JSON.stringify(injected)}`)
  assert.ok(joined.includes('SU'), `imported file content must reach the context; got ${JSON.stringify(injected)}`)
})

await check('D3-04c 100k-line file within raised caps injects fully, no crash', async () => {
  const lines = []
  for (let i = 0; i < 100000; i++) lines.push(`line ${i} paddingpad`)
  const root = makeDir({
    'AGENTS.md': '# root\n\n@huge.md\n',
    'huge.md': lines.join('\n'),
  })
  const entry = { ...defaultEntry, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 }
  const { injected } = await runPlugin({ entry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  const lineFeeds = (injected[0].match(/line \d+ /g) ?? []).length
  assert.ok(lineFeeds >= 99999, `expected all 100k lines, saw ${lineFeeds}`)
})

console.log('\n[D3-05] encoding / line-ending shapes')

await check('D3-05a UTF-8 BOM is stripped from the injected body', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@bom.md\n',
    'bom.md': '\uFEFFBOM_MARKER\n',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.ok(injected[0].includes('BOM_MARKER'), 'marker content present')
  assert.ok(!injected[0].includes('\uFEFF'), 'BOM stripped from the injected text')
})

await check('D3-05b CRLF file: block renders, and dedups against its own replay', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\r\n\r\n@crlf.md\r\n',
    'crlf.md': '# crlf\r\nCRLF_MARKER\r\n',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /CRLF_MARKER/)
  assert.match(injected[0], /# crlf\r?\nCRLF_MARKER\r?\n\r?\n<\/file>/, 'CRLF block shape expected')
  const surface = [userMessage({ kind: 'context-imports', form: 'instructions' }, injected[0])]
  const second = await runPlugin({ entry: defaultEntry, session: makeSession(root, surface) })
  assert.equal(second.injected.length, 0, 'CRLF block must dedup against its replayed surface copy')
})

await check('D3-05c mixed LF/CRLF endings inject without corruption', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@mix.md\n',
    'mix.md': '# mix\nMIX_MARKER_LF\r\nMIX_MARKER_CRLF\r\n',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /MIX_MARKER_LF/)
  assert.match(injected[0], /MIX_MARKER_CRLF/)
})

await check('D3-05d no trailing newline: closing tag still well-formed', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@tail.md\n',
    'tail.md': '# tail\nTAIL_MARKER',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /TAIL_MARKER\n<\/file>/, 'content without trailing LF must still close cleanly')
})

console.log('\n[D3-06] hostile @paths')

await check('D3-06a relative traversal is refused with a visible outside-note', async () => {
  // Extension-less targets (e.g. ...\etc\hosts) never match the scanner regex
  // (pinned in D3-02a2), so the realistic traversal vector is a normal
  // extension-named file outside the workspace — one level up via ../.
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-audit-'))
  const outer = mkdtempSync(join(tmpdir(), 'dsh-outer-'))
  writeFileSync(join(outer, 'secret.md'), 'TRAVERSAL_MARKER\n', 'utf8')
  writeFileSync(join(root, 'AGENTS.md'), `# root\n\n@../${outer.split('\\').pop()}/secret.md\n`, 'utf8')
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1, 'exactly one message expected either way')
  const text = injected[0]
  // FIXED BEHAVIOUR: imports that resolve outside the session cwd are
  // refused with a visible outside-note; the outside content must NOT
  // reach the model context.
  assert.ok(!text.includes('TRAVERSAL_MARKER'), `outside content must not be injected; got ${text.slice(0, 200)}`)
  assert.ok(text.includes('outside the workspace'), `expected a visible outside-note; got: ${text.slice(0, 200)}`)
})

await check('D3-06b @././././x.md normalizes and injects the target', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@././././x.md\n',
    'x.md': 'DOTDOT_MARKER\n',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /DOTDOT_MARKER/, 'redundant ./ segments must resolve to x.md')
})

await check('D3-06c URL-encoded @%2e%2e%2fx.md: silently ignored (% not in class)', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@%2e%2e%2fx.md\n',
    'x.md': 'SHOULD_NOT_APPEAR\n',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 0, 'percent-encoded traversal must not match the import regex')
})

console.log('\n[D3-07] template injection')

await check('D3-07a template "{{content}}{{content}}" duplicates the whole payload', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@a.md\n',
    'a.md': 'TPL_ONCE_MARKER\n',
  })
  const { injected } = await runPlugin({ entry: { ...defaultEntry, template: '{{content}}{{content}}' }, session: makeSession(root) })
  assert.equal(injected.length, 1)
  const hits = injected[0].split('TPL_ONCE_MARKER').length - 1
  assert.equal(hits, 2, `payload duplicated by the doubled placeholder, got ${hits} copies`)
  const opens = injected[0].split('<system-reminder>').length - 1
  assert.equal(opens, 1, 'still exactly one wrapper open')
})

await check('D3-07b template containing </system-reminder> escapes the wrapper early', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@a.md\n',
    'a.md': 'ESC_MARKER\n',
  })
  const template = 'LEAD</system-reminder>PAYLOAD-LOOKS-OUTSIDE{{content}}'
  const { injected } = await runPlugin({ entry: { ...defaultEntry, template }, session: makeSession(root) })
  assert.equal(injected.length, 1)
  const closes = injected[0].split('</system-reminder>').length - 1
  assert.equal(closes, 2, `early escape produces a second closing tag, got ${closes}`)
  // Pinned: the "outside" payload text survives verbatim — the wrapper can be
  // broken from config alone (user-controlled, low severity, still recorded).
  assert.ok(injected[0].includes('PAYLOAD-LOOKS-OUTSIDE'), 'template text after the fake close is rendered verbatim')
})

await check('D3-07c whitespace-only template falls back to the default wrapper', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@a.md\n',
    'a.md': 'WS_MARKER\n',
  })
  const { injected } = await runPlugin({ entry: { ...defaultEntry, template: '   \n\t  ' }, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /^<system-reminder>\n/, 'blank template must use the default wrapper')
  assert.match(injected[0], /WS_MARKER/)
})

console.log('\n[D3-08] symlinks (may SKIP on Windows without dev-mode/admin)')

await check('D3-08a symlinked instruction file is followed and its refs scanned', async () => {
  // The instruction file's own prose is never injected (scanOnly, the stock
  // agent-instructions plugin owns it), so "followed" is observable via the
  // refs inside the symlink target being expanded.
  const outside = makeDir({ 'real.md': '@inner.md\n' })
  const root = makeDir({
    'inner.md': 'SYMLINK_CHAIN_MARKER\n',
    'placeholder': 'x',
  })
  try {
    unlinkSync(join(root, 'placeholder'))
    symlinkSync(join(outside, 'real.md'), join(root, 'AGENTS.md'), 'file')
  } catch (error) {
    return skip('D3-08a', `symlinkSync refused on this volume/account: ${error.code ?? error.message}`)
  }
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /SYMLINK_CHAIN_MARKER/, 'refs inside a symlinked instruction file must expand (symlink followed)')
})

await check('D3-08b symlink inside the @chain is followed', async () => {
  const outside = makeDir({ 'real.md': 'CHAIN_SYMLINK_MARKER\n' })
  const root = makeDir({
    'AGENTS.md': '# root\n\n@link.md\n',
    'placeholder': 'x',
  })
  try {
    unlinkSync(join(root, 'placeholder'))
    symlinkSync(join(outside, 'real.md'), join(root, 'link.md'), 'file')
  } catch (error) {
    return skip('D3-08b', `symlinkSync refused on this volume/account: ${error.code ?? error.message}`)
  }
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /CHAIN_SYMLINK_MARKER/, 'symlinked import target is followed (known behaviour)')
})

console.log('\n[D3-09] degenerate AGENTS.md shapes')

await check('D3-09a empty AGENTS.md injects nothing, no crash', async () => {
  const root = makeDir({ 'AGENTS.md': '' })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 0)
})

await check('D3-09b only @refs, no prose: refs expand normally', async () => {
  const root = makeDir({
    'AGENTS.md': '@a.md\n',
    'a.md': 'ONLY_REFS_MARKER\n',
  })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /ONLY_REFS_MARKER/)
})

await check('D3-09c AGENTS.md referencing itself (self-contained) injects nothing', async () => {
  const root = makeDir({ 'AGENTS.md': '@AGENTS.md\n' })
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root) })
  assert.equal(injected.length, 0, 'self-reference is collapsed by the seen-set before rendering')
})

console.log('\n[D3-10] liveMode value variants')

await check('D3-10a liveMode "INJECT+WAKE" normalizes to off: injects but never wakes', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'CASE_MARKER\n',
  })
  const followups = []
  const { injected } = await runPlugin({
    entry: liveEntry({ liveMode: 'INJECT+WAKE', watchDebounceMs: 50, minReinjectIntervalMs: 50 }),
    session: makeSession(root),
    captureFollowup: (m) => followups.push(m),
  })
  assert.equal(injected.length, 1, 'injection itself is unaffected by the liveMode spelling')
  writeFileSync(join(root, 'imports', 'extra.md'), `# changed ${Date.now()}\n`, 'utf8')
  await sleep(400)
  assert.equal(followups.length, 0, `strict equality means uppercase falls back to off; got ${followups.length} wakes`)
})

await check('D3-10b liveMode " inject+wake " (spaces) normalizes to off', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'SPACE_MARKER\n',
  })
  const followups = []
  const { injected } = await runPlugin({
    entry: liveEntry({ liveMode: ' inject+wake ', watchDebounceMs: 50, minReinjectIntervalMs: 50 }),
    session: makeSession(root),
    captureFollowup: (m) => followups.push(m),
  })
  assert.equal(injected.length, 1)
  writeFileSync(join(root, 'imports', 'extra.md'), `# changed ${Date.now()}\n`, 'utf8')
  await sleep(400)
  assert.equal(followups.length, 0, `untrimmed value falls back to off; got ${followups.length} wakes`)
})

/* ================================================================== *
 * Dimension 4 — live watcher edges
 * ================================================================== */

console.log('\n[D4-11] watched file deleted / recreated')

await check('D4-11 delete fires (or not) and recreate recovery is pinned', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'V1\n',
  })
  const followups = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50 }),
    session: makeSession(root),
    captureFollowup: (m) => followups.push(m),
  })
  await sleep(200) // age past the injection-time throttle stamp
  const before = followups.length
  unlinkSync(join(root, 'imports', 'extra.md'))
  await sleep(300)
  const afterDelete = followups.length
  console.log(`        [observed] followups before=${before}, after delete=${afterDelete} (delete ${afterDelete > before ? 'DID wake' : 'did not wake'})`)
  // Recreate the same path and touch it — the classic fs.watch inode/handle trap.
  writeFileSync(join(root, 'imports', 'extra.md'), 'V2 recreated\n', 'utf8')
  await sleep(300)
  writeFileSync(join(root, 'imports', 'extra.md'), 'V3 touch after recreate\n', 'utf8')
  await sleep(300)
  const afterRecreate = followups.length
  console.log(`        [observed] after delete+recreate+touch=${afterRecreate} (watcher ${afterRecreate > afterDelete ? 'SURVIVED and re-armed' : 'LOST — no recovery'})`)
  // Either outcome is a documented behaviour, not an assertion failure; the
  // process must not crash and must not wake a session whose file is gone
  // *while staying silent forever* is graded in the report.
  assert.ok(afterDelete >= before, 'followup counter must never go backwards')
})

console.log('\n[D4-12] atomic save (write tmp + rename over)')

await check('D4-12 rename-over-save triggers debounce and re-injects NEW content', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'V1_ATOMIC\n',
  })
  const followups = []
  const entry = liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50 })
  // Real fiber (effect + listeners), like runPlugin but we keep the listeners.
  const fiber = makeCtx()
  apply(fiber.ctx, entry)
  fiber.listeners.get('agent/created')({ source: 'startup', agent: { session: makeSession(root), id: 'a1' } })
  const session1 = makeSession(root)
  const agent1 = { session: session1, id: 'a1', inbox: { nextStep: [] }, followup: (m) => followups.push(m) }
  const first = await stepOn(fiber.listeners, agent1)
  const v1 = (first?.messages ?? []).filter((m) => m?.source?.kind === 'context-imports')
    .map((m) => (m.content ?? []).map((p) => p.text ?? '').join('\n')).join('\n')
  assert.match(v1, /V1_ATOMIC/, 'first injection carries V1')

  await sleep(200) // clear the injection-time throttle stamp
  const tmp = join(root, 'imports', `extra.md.tmp-${Date.now()}`)
  writeFileSync(tmp, 'V2_ATOMIC_RENAMED\n', 'utf8')
  renameSync(tmp, join(root, 'imports', 'extra.md'))
  await sleep(400)
  assert.ok(followups.length >= 1, `rename-over save must trigger at least one wake, got ${followups.length}`)
  assert.equal(followups[0]?.source?.kind, 'context-imports-wake')

  // The next gate sees the surface copy of V1 and injects only the NEW block.
  const surface = [userMessage({ kind: 'context-imports', form: 'instructions' }, v1)]
  const session2 = makeSession(root, surface)
  const agent2 = { session: session2, id: 'a1', inbox: { nextStep: [] }, followup: (m) => followups.push(m) }
  const second = await stepOn(fiber.listeners, agent2)
  const v2 = (second?.messages ?? []).filter((m) => m?.source?.kind === 'context-imports')
    .map((m) => (m.content ?? []).map((p) => p.text ?? '').join('\n')).join('\n')
  assert.match(v2, /V2_ATOMIC_RENAMED/, 're-injection must carry the renamed file content')
  assert.doesNotMatch(v2, /V1_ATOMIC/, 'old block must be deduped away')
  void first
})

console.log('\n[D4-13] write burst (10 writes @50ms)')

await check('D4-13 burst of 10 writes yields at most 2 followups', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'V1\n',
  })
  const followups = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 1000 }),
    session: makeSession(root),
    captureFollowup: (m) => followups.push(m),
  })
  await sleep(1200) // age past the injection-time throttle stamp (minReinjectIntervalMs=1000)
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(root, 'imports', 'extra.md'), `# burst ${i} @ ${Date.now()}\n`, 'utf8')
    await sleep(50)
  }
  await sleep(400)
  console.log(`        [observed] ${followups.length} followup(s) for the 10-write burst`)
  assert.ok(followups.length <= 2, `debounce+throttle must collapse the burst to <=2, got ${followups.length}`)
  assert.ok(followups.length >= 1, 'the burst must not be entirely swallowed')
})

console.log('\n[D4-14] two sessions share one watched file')

await check('D4-14a one session disposed: the other still gets woken', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'SHARED_V1\n',
  })
  const fiber = makeCtx()
  apply(fiber.ctx, liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50 }))
  const s1 = makeSession(root)
  const s2 = makeSession(root)
  fiber.listeners.get('agent/created')({ source: 'startup', agent: { session: s1, id: 'a1' } })
  fiber.listeners.get('agent/created')({ source: 'startup', agent: { session: s2, id: 'a2' } })
  const f1 = []
  const f2 = []
  await stepOn(fiber.listeners, { session: s1, id: 'a1', inbox: { nextStep: [] }, followup: (m) => f1.push(m) })
  await stepOn(fiber.listeners, { session: s2, id: 'a2', inbox: { nextStep: [] }, followup: (m) => f2.push(m) })
  await sleep(200)
  fiber.listeners.get('agent/disposed')({ agent: { session: s1, id: 'a1' } })
  writeFileSync(join(root, 'imports', 'extra.md'), `# changed ${Date.now()}\n`, 'utf8')
  await sleep(400)
  assert.equal(f1.length, 0, 'disposed session must not be woken')
  assert.ok(f2.length >= 1, `surviving session must still be woken, got ${f2.length}`)
})

await check('D4-14b all sessions disposed: watcher closed, no more wakes', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'SHARED_V1\n',
  })
  const fiber = makeCtx()
  apply(fiber.ctx, liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50 }))
  const s1 = makeSession(root)
  const f1 = []
  fiber.listeners.get('agent/created')({ source: 'startup', agent: { session: s1, id: 'a1' } })
  await stepOn(fiber.listeners, { session: s1, id: 'a1', inbox: { nextStep: [] }, followup: (m) => f1.push(m) })
  await sleep(200)
  fiber.listeners.get('agent/disposed')({ agent: { session: s1, id: 'a1' } })
  await sleep(50)
  writeFileSync(join(root, 'imports', 'extra.md'), `# changed ${Date.now()}\n`, 'utf8')
  await sleep(400)
  assert.equal(f1.length, 0, `watcher with zero sessions must be closed; got ${f1.length} wakes`)
})

console.log('\n[D4-15] liveMode switched back to off')

await check('D4-15 fiber unload (patch reload path) tears down watchers', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'OFFTEST_V1\n',
  })
  const f1 = []
  const fiber = makeCtx()
  apply(fiber.ctx, liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50 }))
  const s1 = makeSession(root)
  fiber.listeners.get('agent/created')({ source: 'startup', agent: { session: s1, id: 'a1' } })
  await stepOn(fiber.listeners, { session: s1, id: 'a1', inbox: { nextStep: [] }, followup: (m) => f1.push(m) })
  await sleep(200)
  // The only real "switch to off" path is a profile-patch reload, which
  // unloads the fiber: every effect dispose runs (closes all watchers).
  for (const dispose of fiber.disposers) dispose()
  writeFileSync(join(root, 'imports', 'extra.md'), `# changed ${Date.now()}\n`, 'utf8')
  await sleep(400)
  assert.equal(f1.length, 0, `after fiber teardown no wake may arrive; got ${f1.length}`)
})

console.log('\n[D4-16] watchDebounceMs = 0 / negative')

await check('D4-16a watchDebounceMs=0 falls back to 30000 (no immediate fire)', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'ZERO_V1\n',
  })
  const f1 = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 0, minReinjectIntervalMs: 50 }),
    session: makeSession(root),
    captureFollowup: (m) => f1.push(m),
  })
  await sleep(200)
  writeFileSync(join(root, 'imports', 'extra.md'), `# changed ${Date.now()}\n`, 'utf8')
  await sleep(500)
  // If 0 were honored the wake would already have fired; the num() guard
  // (n > 0) rejects it and falls back to the 30s default — nothing within 500ms.
  assert.equal(f1.length, 0, `0 must be rejected (fallback 30s), so no wake within 500ms; got ${f1.length}`)
})

await check('D4-16b watchDebounceMs=-5 falls back to 30000 (no immediate fire)', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'NEG_V1\n',
  })
  const f1 = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: -5, minReinjectIntervalMs: 50 }),
    session: makeSession(root),
    captureFollowup: (m) => f1.push(m),
  })
  await sleep(200)
  writeFileSync(join(root, 'imports', 'extra.md'), `# changed ${Date.now()}\n`, 'utf8')
  await sleep(500)
  assert.equal(f1.length, 0, `negative must be rejected (fallback 30s), so no wake within 500ms; got ${f1.length}`)
})

console.log('\n[D4-17] race: file changed immediately after injection')

await check('D4-17 injection no longer occupies the change-throttle window: instant change wakes', async () => {
  const root = makeDir({
    'AGENTS.md': '# root\n\n@imports/extra.md\n',
    'imports/extra.md': 'RACE_V1\n',
  })
  const f1 = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 400 }),
    session: makeSession(root),
    captureFollowup: (m) => f1.push(m),
  })
  // FIXED BEHAVIOUR: injection no longer stamps the CHANGE throttle, so an
  // instant change right after injection wakes the agent immediately.
  writeFileSync(join(root, 'imports', 'extra.md'), 'RACE_V2 instant\n', 'utf8')
  await sleep(400)
  assert.ok(f1.length >= 1, `instant change after injection must wake, got ${f1.length}`)
  // A second change inside the change-throttle window stays throttled.
  const count = f1.length
  writeFileSync(join(root, 'imports', 'extra.md'), 'RACE_V2b inside window\n', 'utf8')
  await sleep(300)
  assert.ok(f1.length <= count + 1, 'churn inside the window must not storm wakes')
  console.log(`        [observed] followups after window=${f1.length}`)
})

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed === 0 ? 0 : 1)
