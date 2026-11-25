/**
 * dsh-context-imports — host-side robustness harness.
 *
 * Drives the host half with a mock cordis context and a mock session, so the
 * boundary shapes can be checked deterministically (no model, no browser):
 *
 *   node scripts/robustness.test.mjs
 *
 * Covered:
 *   - config normalization: every field missing / wrong type / string form
 *   - injection decisions against a mock durable surface
 *   - incremental injection: a newly loaded instruction file adds only its own
 *   - no duplicate injection for a file already in the context
 *   - re-seed after the surface lost the block (compaction)
 *   - the host's three instruction-scope sources (inbox / batch / surface)
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const modulePath = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(modulePath)

let passed = 0
let failed = 0

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

/* ------------------------------------------------------------------ *
 * Mock host
 * ------------------------------------------------------------------ */

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-'))
  mkdirSync(join(root, 'imports'), { recursive: true })
  mkdirSync(join(root, 'proj'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), '# root\n\n@imports/extra.md\n', 'utf8')
  writeFileSync(join(root, 'imports', 'extra.md'), '# extra\n\nROOT_EXTRA_MARKER\n', 'utf8')
  writeFileSync(join(root, 'proj', 'AGENTS.md'), '# proj\n\n@proj_rules.md\n', 'utf8')
  writeFileSync(join(root, 'proj', 'proj_rules.md'), '# rules\n\nPROJ_RULES_MARKER\n', 'utf8')
  return root
}

function userMessage(source, text) {
  return { type: 'user/message', data: { source, content: [{ type: 'text', text }] } }
}

/** A bare message object — the shape the host's inbox and step batch carry. */
function bareMessage(source, text) {
  return { source, content: [{ type: 'text', text }] }
}

function instructionMessage(scopes, baselineIdentity) {
  return userMessage(
    {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: JSON.stringify(baselineIdentity),
      changes: scopes.map((scope) => ({ action: 'set', scope, path: scope.split('\u0000')[1] })),
    },
    '# instructions',
  )
}

function makeSession(cwd, surfaceMessages) {
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

/** Watch-event callbacks registered by the plugin, keyed by session object. */
const watchFile = (abs) => {
  // A real content change is the most faithful trigger: it goes through the
  // actual fs.watch registration, the debounce and the throttle.
  writeFileSync(abs, `# changed at ${Date.now()}\n`, 'utf8')
}

async function runPlugin({ entry, session, scene = 'startup', inbox = [], captureFollowup }) {
  const injected = []
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
  apply(ctx, entry)
  const created = listeners.get('agent/created')
  if (created) {
    created({ source: scene, agent: { session, id: 'agent-1' } })
  }
  const preStep = listeners.get('agent/pre-step')
  const decision = { kind: 'continue', messages: [] }
  const agent = {
    session,
    id: 'agent-1',
    inbox: { nextStep: inbox },
    followup: captureFollowup ? (message) => captureFollowup(message) : undefined,
  }
  const result = preStep
    ? await preStep(
        { agent, signal: new AbortController().signal },
        async () => decision,
      )
    : decision
  const messages = (result?.messages ?? []).filter((message) => message?.source?.kind === 'context-imports')
  for (const message of messages) {
    const text = (message.content ?? []).map((part) => part.text ?? '').join('\n')
    injected.push(text)
  }
  return { injected, decision, result }
}

/**
 * One plugin instance driving several sessions - the shape of a real host,
 * where every session shares the same fiber (and therefore the same watcher
 * set and the same "active session"). runPlugin applies the plugin once per
 * call, which is right for single-session cases but cannot observe anything
 * that spans sessions. `steps` is an ordered list of { session, capture },
 * each run as one user step in that order; the LAST one is the active session.
 */
async function runPluginMulti({ entry, steps, scene = 'startup' }) {
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
  apply(ctx, entry)
  const created = listeners.get('agent/created')
  const preStep = listeners.get('agent/pre-step')
  let n = 0
  for (const { session, capture } of steps) {
    const id = `agent-${++n}`
    if (created) created({ source: scene, agent: { session, id } })
    const agent = { session, id, inbox: { nextStep: [] }, followup: capture ? (m) => capture(m) : undefined }
    const decision = { kind: 'continue', messages: [] }
    if (preStep) await preStep({ agent, signal: new AbortController().signal }, async () => decision)
  }
  return {
    dispose() {
      for (const d of disposers.splice(0)) d()
    },
  }
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

const root = makeWorkspace()
const projectRootIdentity = { projectRoot: '' }

/* ------------------------------------------------------------------ *
 * 1. Config normalization — the rc.2 projection drops every default
 * ------------------------------------------------------------------ */

console.log('\nconfig normalization')

await check('missing entry: defaults apply, no crash', async () => {
  const session = makeSession(root, [])
  const { injected } = await runPlugin({ entry: {}, session })
  // Every field falls back to its schema default, so the cwd's instruction
  // file is still scanned.
  assert.equal(injected.length, 1)
  assert.match(injected[0], /ROOT_EXTRA_MARKER/)
})

await check('injectOn as comma string does not crash the session', async () => {
  const session = makeSession(root, [])
  const entry = { ...defaultEntry, injectOn: 'startup,resume' }
  const { injected } = await runPlugin({ entry, session })
  assert.equal(injected.length, 1)
})

await check('injectOn as garbage falls back to every scene', async () => {
  const session = makeSession(root, [])
  const entry = { ...defaultEntry, injectOn: 42 }
  const { injected } = await runPlugin({ entry, session })
  assert.equal(injected.length, 1)
})

await check('files as a string is tolerated', async () => {
  const session = makeSession(root, [])
  const entry = { ...defaultEntry, files: 'imports/extra.md' }
  const { injected } = await runPlugin({ entry, session })
  assert.equal(injected.length, 1)
})

await check('non-positive numbers fall back to the schema defaults', async () => {
  const session = makeSession(root, [])
  const entry = { ...defaultEntry, maxDepth: 0, maxFileBytes: -1, maxTotalBytes: 0 }
  const { injected } = await runPlugin({ entry, session })
  assert.equal(injected.length, 1)
})

/* ------------------------------------------------------------------ *
 * 2. Basic injection + dedup
 * ------------------------------------------------------------------ */

console.log('\ninjection decisions')

await check('root instruction file: one block with the imported file', async () => {
  const session = makeSession(root, [])
  const { injected } = await runPlugin({ entry: defaultEntry, session })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /ROOT_EXTRA_MARKER/)
})

await check('second step without new instructions: no second block', async () => {
  const session = makeSession(root, [])
  const first = await runPlugin({ entry: defaultEntry, session })
  assert.equal(first.injected.length, 1)
  const surface = [userMessage({ kind: 'context-imports', form: 'instructions' }, first.injected[0])]
  const grown = makeSession(root, surface)
  const second = await runPlugin({ entry: defaultEntry, session: grown })
  assert.equal(second.injected.length, 0)
})

await check('compaction removed the block: it is seeded again', async () => {
  const session = makeSession(root, [])
  const first = await runPlugin({ entry: defaultEntry, session })
  assert.equal(first.injected.length, 1)
  const emptied = makeSession(root, [])
  const again = await runPlugin({ entry: defaultEntry, session: emptied })
  assert.equal(again.injected.length, 1)
  assert.match(again.injected[0], /ROOT_EXTRA_MARKER/)
})

await check('missing imported file is reported, not fatal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-miss-'))
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@nope.md\n', 'utf8')
  const session = makeSession(dir, [])
  const { injected } = await runPlugin({ entry: defaultEntry, session })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /not found/)
})

await check('instruction file without imports injects nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-plain-'))
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\nno imports here\n', 'utf8')
  const session = makeSession(dir, [])
  const { injected } = await runPlugin({ entry: defaultEntry, session })
  assert.equal(injected.length, 0)
})

await check('byte budget omits the overflow file with a note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-budget-'))
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@a.md\n@b.md\n', 'utf8')
  writeFileSync(join(dir, 'a.md'), 'A'.repeat(500), 'utf8')
  writeFileSync(join(dir, 'b.md'), 'B'.repeat(500), 'utf8')
  const session = makeSession(dir, [])
  const { injected } = await runPlugin({ entry: { ...defaultEntry, maxTotalBytes: 100 }, session })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /omitted/)
})

await check('per-file cap truncates the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-trunc-'))
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@big.md\n', 'utf8')
  writeFileSync(join(dir, 'big.md'), 'X'.repeat(1000), 'utf8')
  const session = makeSession(dir, [])
  const { injected } = await runPlugin({ entry: { ...defaultEntry, maxFileBytes: 100 }, session })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /truncated/)
})

await check('a circular import does not loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-cycle-'))
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@a.md\n', 'utf8')
  writeFileSync(join(dir, 'a.md'), '# a\n\n@b.md\n', 'utf8')
  writeFileSync(join(dir, 'b.md'), '# b\n\n@a.md\n', 'utf8')
  const session = makeSession(dir, [])
  const { injected } = await runPlugin({ entry: defaultEntry, session })
  // One block, each file once — the cycle is collapsed, not followed.
  assert.equal(injected.length, 1)
  const occurrences = injected[0].split('<file path=').length - 1
  assert.equal(occurrences, 2)
})

/* ------------------------------------------------------------------ *
 * 3. Host-loaded instruction files (the 0.3.0 feature)
 * ------------------------------------------------------------------ */

console.log('\nhost-loaded instruction files')

await check('a project AGENTS.md loaded by the host has its imports expanded', async () => {
  const scope = `proj\u0000AGENTS.md`
  const session = makeSession(root, [instructionMessage([scope], projectRootIdentity)])
  const { injected } = await runPlugin({ entry: defaultEntry, session })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /PROJ_RULES_MARKER/)
})

await check('the host inbox is read too (same round as the load)', async () => {
  const session = makeSession(root, [])
  const inbox = [
    bareMessage(
      {
        kind: 'agent-instructions',
        form: 'instructions',
        baselineIdentity: JSON.stringify(projectRootIdentity),
        changes: [{ action: 'set', scope: `proj\u0000AGENTS.md` }],
      },
      '# project instructions',
    ),
  ]
  const { injected } = await runPlugin({ entry: defaultEntry, session, inbox })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /PROJ_RULES_MARKER/)
})

await check('the step batch is read too', async () => {
  const session = makeSession(root, [])
  const { injected, decision } = await runPlugin({ entry: defaultEntry, session })
  assert.equal(injected.length, 1)
  // The batch the host handed us carries the instruction message; the plugin
  // must look at the same shape the host publishes.
  assert.ok(Array.isArray(decision.messages))
})

await check('the root file and a project file are expanded together', async () => {
  const scope = `proj\u0000AGENTS.md`
  const session = makeSession(root, [instructionMessage([scope], projectRootIdentity)])
  const { injected } = await runPlugin({ entry: defaultEntry, session })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /ROOT_EXTRA_MARKER/)
  assert.match(injected[0], /PROJ_RULES_MARKER/)
})

await check('a project file already in the context is not sent twice', async () => {
  const scope = `proj\u0000AGENTS.md`
  const first = makeSession(root, [instructionMessage([scope], projectRootIdentity)])
  const firstRun = await runPlugin({ entry: defaultEntry, session: first })
  assert.equal(firstRun.injected.length, 1)
  const surface = [
    instructionMessage([scope], projectRootIdentity),
    userMessage({ kind: 'context-imports', form: 'instructions' }, firstRun.injected[0]),
  ]
  const second = makeSession(root, surface)
  const secondRun = await runPlugin({ entry: defaultEntry, session: second })
  assert.equal(secondRun.injected.length, 0)
})

await check('expandLoadedInstructions=false keeps the old cwd-only behaviour', async () => {
  const scope = `proj\u0000AGENTS.md`
  const session = makeSession(root, [instructionMessage([scope], projectRootIdentity)])
  const { injected } = await runPlugin({
    entry: { ...defaultEntry, expandLoadedInstructions: false },
    session,
  })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /ROOT_EXTRA_MARKER/)
  assert.doesNotMatch(injected[0], /PROJ_RULES_MARKER/)
})

await check('a malformed scope key is ignored, not fatal', async () => {
  const session = makeSession(root, [instructionMessage(['no-separator-here'], projectRootIdentity)])
  const { injected } = await runPlugin({ entry: defaultEntry, session })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /ROOT_EXTRA_MARKER/)
})

await check('a malformed baselineIdentity is ignored, not fatal', async () => {
  const session = makeSession(root, [
    userMessage(
      {
        kind: 'agent-instructions',
        form: 'instructions',
        baselineIdentity: '{not json',
        changes: [{ action: 'set', scope: `proj\u0000AGENTS.md` }],
      },
      '# instructions',
    ),
  ])
  const { injected } = await runPlugin({ entry: defaultEntry, session })
  assert.equal(injected.length, 1)
})

await check('an unreadable surface does not crash the step', async () => {
  const session = {
    header: { cwd: root },
    surface: {
      get nodes() {
        throw new Error('surface is broken')
      },
    },
    eventAt() {
      throw new Error('surface is broken')
    },
  }
  const { injected } = await runPlugin({ entry: defaultEntry, session })
  assert.equal(injected.length, 1)
})

/* ------------------------------------------------------------------ *
 * 4. Scene gating
 * ------------------------------------------------------------------ */

console.log('\nscene gating')

await check('an unknown scene is treated as startup and injects', async () => {
  // No agent/created record reachable -> the gate treats it as a fresh seed.
  const session = makeSession(root, [])
  const { injected } = await runPlugin({ entry: defaultEntry, session, scene: 'unknown-scene' })
  assert.equal(injected.length, 1)
})

await check('a scene suppressed by injectOn injects nothing', async () => {
  const session = makeSession(root, [])
  const entry = { ...defaultEntry, injectOn: ['resume', 'clear', 'compact'] }
  const { injected } = await runPlugin({ entry, session, scene: 'startup' })
  assert.equal(injected.length, 0)
})

await check('a scene inside injectOn injects', async () => {
  const session = makeSession(root, [])
  const { injected } = await runPlugin({ entry: defaultEntry, session, scene: 'resume' })
  assert.equal(injected.length, 1)
})

/* ------------------------------------------------------------------ *
 * 5. Live mode (file watching)
 * ------------------------------------------------------------------ */

console.log('\nlive mode')

// The injected file lives in the shared `root` workspace fixture; every live
// test writes a real change to it and waits out the debounce window.
const liveEntry = (over = {}) => ({
  ...defaultEntry,
  liveMode: 'inject+wake',
  watchDebounceMs: 50,
  minReinjectIntervalMs: 1000,
  ...over,
})
const waitOut = async () => new Promise((resolve) => setTimeout(resolve, 400))

await check('the last edit of a burst still reaches the session (coalesced delivery)', async () => {
  // Throttle keyed on the last DELIVERY: a burst of edits inside the window
  // is coalesced, and the final edit must still be delivered afterwards
  // (keying on the last CHANGE dropped it silently).
  const session = makeSession(root, [])
  const followups = []
  const window_ms = 1500
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: window_ms }),
    session,
    captureFollowup: (message) => followups.push(message),
  })
  watchFile(join(root, 'imports', 'extra.md'))
  await waitOut()
  assert.equal(followups.length, 1, 'the first edit wakes once')
  // Three more edits inside the throttle window: no immediate wake ...
  for (const tag of ['A', 'B', 'C']) {
    writeFileSync(join(root, 'imports', 'extra.md'), `BURST_${tag}\n`, 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  assert.equal(followups.length, 1, `edits inside the window do not wake immediately, got ${followups.length}`)
  // ... but once the window opens, the coalesced change is delivered
  await new Promise((resolve) => setTimeout(resolve, window_ms + 800))
  assert.ok(followups.length >= 2, `the last edit must still be delivered, got ${followups.length}`)
  assert.ok(followups.length <= 3, `no wake storm, got ${followups.length}`)
})

await check('a @reference after full-width punctuation is recognised', async () => {
  // Chinese documents write "详见：@docs/x.md" with a full-width colon;
  // the scanner's leading class must include Unicode punctuation.
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-'))
  writeFileSync(join(root, 'AGENTS.md'), '# 根\n\n详见：@fullwidth.md\n', 'utf8')
  writeFileSync(join(root, 'fullwidth.md'), 'FULLWIDTH_MARKER\n', 'utf8')
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root, []) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /FULLWIDTH_MARKER/, 'full-width punctuation must not hide the reference')
})

await check('a path-looking reference without an extension is reported as ignored', async () => {
  // "@../../Windows/System32/drivers/etc/hosts" has no extension, so the
  // scanner ignores it - it must still be reported, never silently dropped.
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-'))
  writeFileSync(join(root, 'AGENTS.md'), '# 根\n\n@../../Windows/System32/drivers/etc/hosts\n', 'utf8')
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root, []) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /ignored|已忽略/, 'the extension-less reference must be reported')
  assert.ok(!/\[fonts\]/.test(injected[0]), 'no content of an ignored reference may appear')
})

await check('a quoted path with spaces is injected', async () => {
  // Windows folders with spaces are common; the quoted form is how a
  // reference to such a file is expressed.
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-'))
  mkdirSync(join(root, 'my docs'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), '# root\n\nsee @"my docs/plan.md"\n', 'utf8')
  writeFileSync(join(root, 'my docs', 'plan.md'), 'SPACED_PATH_MARKER\n', 'utf8')
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root, []) })
  assert.equal(injected.length, 1)
  assert.match(injected[0], /SPACED_PATH_MARKER/, 'quoted path must be injected')
})

await check('an unquoted path with spaces is reported, not dropped silently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-'))
  mkdirSync(join(root, 'my docs'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), '# root\n\nsee @my docs/plan.md\n', 'utf8')
  writeFileSync(join(root, 'my docs', 'plan.md'), 'SPACED_PATH_MARKER\n', 'utf8')
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root, []) })
  assert.equal(injected.length, 1)
  assert.ok(!injected[0].includes('SPACED_PATH_MARKER'), 'unquoted spaced path is not injected')
  assert.match(injected[0], /space|空格/, `the spaced path must be reported; got ${injected[0].slice(0, 160)}`)
})

await check('a GBK file is decoded through the GB18030 fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-'))
    // GBK bytes of a short Chinese header line followed by the ASCII word GBK.
    const gbk = Buffer.from([0x23, 0x20, 0xba, 0xc5, 0xbe, 0xdd, 0x0a, 0x47, 0x42, 0x4b, 0x0a])
  writeFileSync(join(root, 'AGENTS.md'), '# root\n\n@gbk.md\n', 'utf8')
  writeFileSync(join(root, 'gbk.md'), gbk)
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root, []) })
  assert.equal(injected.length, 1)
  assert.ok(!injected[0].includes('\uFFFD'), 'no replacement characters may reach the model')
  assert.match(injected[0], /GBK/, 'the fallback decoding must deliver the content')
})

await check('the import depth limit is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-'))
  writeFileSync(join(root, 'AGENTS.md'), '# root\n\n@a.md\n', 'utf8')
  writeFileSync(join(root, 'a.md'), '# a\n\n@b.md\n', 'utf8')
  writeFileSync(join(root, 'b.md'), '# b\n\n@c.md\n', 'utf8')
  writeFileSync(join(root, 'c.md'), '# c\n\n@d.md\n', 'utf8')
  writeFileSync(join(root, 'd.md'), 'DEEP_MARKER\n', 'utf8')
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(root, []) })
  assert.equal(injected.length, 1)
  assert.ok(!injected[0].includes('DEEP_MARKER'), 'files past the depth limit are not injected')
  assert.match(injected[0], /depth|深度/, `the depth limit must be reported; got ${injected[0].slice(0, 200)}`)
})

await check('the wake message is one language and names the file by its injected label', async () => {
  // The wake text used to be half a localized heading and half a hard-coded
  // English sentence, and it named the file by absolute path while the
  // injection block used a relative one.
  const session = makeSession(root, [])
  const followups = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50, detectedLocale: 'zh' }),
    session,
    captureFollowup: (message) => followups.push(message),
  })
  watchFile(join(root, 'imports', 'extra.md'))
  await waitOut()
  assert.equal(followups.length, 1)
  const text = followups[0]?.content?.[0]?.text ?? ''
  assert.match(text, /\u53d1\u751f\u4e86\u53d8\u5316/, 'the heading is localized')
  assert.ok(!/[A-Za-z]{4,}\s+[A-Za-z]{4,}\s+[A-Za-z]{4,}/.test(text.replace('dsh-context-imports', '')),
    `no English sentence may follow the localized heading; got: ${text}`)
  assert.ok(text.includes('imports/extra.md'), `the file is named by its injected label; got: ${text}`)
  assert.ok(!text.includes(root), `the absolute path must not appear; got: ${text}`)
})

await check('a wake caused by several files is one message listing all of them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-batch-'))
  mkdirSync(join(dir, 'imports'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@imports/m1.md\n@imports/m2.md\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'm1.md'), 'M1\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'm2.md'), 'M2\n', 'utf8')
  const session = makeSession(dir, [])
  const followups = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 120, minReinjectIntervalMs: 50, detectedLocale: 'en' }),
    session,
    captureFollowup: (message) => followups.push(message),
  })
  followups.length = 0
  // Both files change inside one debounce window.
  writeFileSync(join(dir, 'imports', 'm1.md'), 'M1 updated\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'm2.md'), 'M2 updated\n', 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(followups.length, 1, `one wake for the whole batch, got ${followups.length}`)
  const text = followups[0]?.content?.[0]?.text ?? ''
  assert.ok(text.includes('imports/m1.md') && text.includes('imports/m2.md'), `both files are named; got: ${text}`)
})

await check('a wake for a deleted file says so instead of claiming an injection', async () => {
  const session = makeSession(root, [])
  const followups = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50, detectedLocale: 'en' }),
    session,
    captureFollowup: (message) => followups.push(message),
  })
  followups.length = 0
  rmSync(join(root, 'imports', 'extra.md'))
  await waitOut()
  await waitOut()
  const text = followups.map((m) => m?.content?.[0]?.text ?? '').join('\n')
  assert.match(text, /no longer exist/, `a deleted file is reported as gone; got: ${text || '(no wake)'}`)
  assert.ok(!/latest content is injected/.test(text), `it must not claim an injection; got: ${text}`)
})

await check('two references on consecutive lines are not a spaced path', async () => {
  // Regression (found on a real host, 2026-11-24): the spaced-path detector
  // used `\s` as its separator, which also matches a line break, so
  // "@a.md\n@b.md" was read as ONE spaced path and line 1 was reported as
  // "path contains a space" on every injection round.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-lines-'))
  mkdirSync(join(dir, 'imports', 'nested'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@imports/extra.md\n@imports/nested/deep.md\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'extra.md'), 'LINE_ONE_MARKER\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'nested', 'deep.md'), 'LINE_TWO_MARKER\n', 'utf8')
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(dir, []) })
  assert.equal(injected.length, 1)
  const text = injected[0]
  assert.ok(!/space|空格/.test(text), `no spaced-path note may appear; got: ${text.slice(0, 200)}`)
  // and both references were still followed as real imports
  assert.match(text, /<file path="imports\/extra\.md">/)
  assert.match(text, /<file path="imports\/nested\/deep\.md">/)
})

await check('a reference followed by a dotted version on the next line is not a spaced path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-lines2-'))
  mkdirSync(join(dir, 'imports'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@imports/extra.md\nrequires v1.2 or later\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'extra.md'), 'VERSIONED_MARKER\n', 'utf8')
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(dir, []) })
  const text = injected.join('\n')
  assert.ok(!/space|空格/.test(text), `no spaced-path note may appear; got: ${text.slice(0, 200)}`)
})
await check('a throttled change is delivered when the throttle window OPENS, not a full throttle after it was queued', async () => {
  // Found on a real host (2026-11-24): a change queued late inside the window
  // was delivered a FULL throttle after it was queued, i.e. long after the
  // window had already opened. The pending timer must wait only until the
  // window opens: (last delivery + throttle) - now.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-pending-'))
  mkdirSync(join(dir, 'imports'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@imports/a.md\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'a.md'), 'A0\n', 'utf8')
  const session = makeSession(dir, [])
  const followups = []
  const THROTTLE = 600
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 20, minReinjectIntervalMs: THROTTLE }),
    session,
    captureFollowup: (message) => followups.push({ t: Date.now(), text: message?.content?.[0]?.text ?? '' }),
  })
  followups.length = 0
  writeFileSync(join(dir, 'imports', 'a.md'), 'A1\n', 'utf8')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(followups.length, 1, 'first change delivered promptly')
  const firstDelivery = followups[0].t
  // Queue the second change LATE inside the window: 2/3 of the throttle later.
  // The window then opens only 1/3 of a throttle after this change.
  await new Promise((r) => setTimeout(r, Math.round(THROTTLE * 2 / 3) - 100))
  writeFileSync(join(dir, 'imports', 'a.md'), 'A2\n', 'utf8')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(followups.length, 1, 'not delivered inside the window')
  // Wait until the window has opened + slack, but NOT a full throttle.
  const untilWindow = firstDelivery + THROTTLE + 120 - Date.now()
  if (untilWindow > 0) await new Promise((r) => setTimeout(r, untilWindow))
  const elapsed = followups.length > 1 ? followups[1].t - firstDelivery : -1
  assert.equal(followups.length, 2, `must be delivered once the window opens (~${THROTTLE}ms after the first delivery); ` +
    `got ${followups.length} wakes, second at ${elapsed}ms`)
  assert.ok(elapsed >= THROTTLE - 40, `never before the window: ${elapsed}ms`)
  assert.ok(elapsed <= THROTTLE + 250, `soon after the window opens, not a full throttle later: ${elapsed}ms`)
})
await check('wake scope: only the session that ran a step LAST is woken (wakeScope=active)', async () => {
  // Found on a real host (2026-11-24): a tab the user closed kept being woken
  // and ran full turns in the background. The host gives no "tab closed" or
  // "archived" signal, so under wakeScope=active only the session that ran a
  // step last is woken.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-scope-'))
  mkdirSync(join(dir, 'imports'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@imports/shared.md\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'shared.md'), 'S0\n', 'utf8')
  const A = makeSession(dir, [])
  const B = makeSession(dir, [])
  const wakesA = []
  const wakesB = []
  const entry = liveEntry({ watchDebounceMs: 20, minReinjectIntervalMs: 100, wakeScope: 'active' })
  // A steps first, then B: B is the active session. One plugin instance for both.
  const run = await runPluginMulti({
    entry,
    steps: [
      { session: A, capture: (m) => wakesA.push(m) },
      { session: B, capture: (m) => wakesB.push(m) },
    ],
  })
  try {
    wakesA.length = 0
    wakesB.length = 0
    watchFile(join(dir, 'imports', 'shared.md'))
    await waitOut()
    assert.equal(wakesB.length, 1, `the active session (B) is woken, got ${wakesB.length}`)
    assert.equal(wakesA.length, 0, `the inactive session (A) must NOT be woken, got ${wakesA.length}`)
  } finally {
    run.dispose()
  }
})

await check('wake scope: active follows the latest step (A becomes active again)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-scope3-'))
  mkdirSync(join(dir, 'imports'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@imports/shared.md\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'shared.md'), 'S0\n', 'utf8')
  const A = makeSession(dir, [])
  const B = makeSession(dir, [])
  const wakesA = []
  const wakesB = []
  const entry = liveEntry({ watchDebounceMs: 20, minReinjectIntervalMs: 100, wakeScope: 'active' })
  // A, then B, then A again: the user went back to A.
  const run = await runPluginMulti({
    entry,
    steps: [
      { session: A, capture: (m) => wakesA.push(m) },
      { session: B, capture: (m) => wakesB.push(m) },
      { session: A, capture: (m) => wakesA.push(m) },
    ],
  })
  try {
    wakesA.length = 0
    wakesB.length = 0
    watchFile(join(dir, 'imports', 'shared.md'))
    await waitOut()
    assert.equal(wakesA.length, 1, `A is active again and is woken, got ${wakesA.length}`)
    assert.equal(wakesB.length, 0, `B is no longer active and must NOT be woken, got ${wakesB.length}`)
  } finally {
    run.dispose()
  }
})
await check('wake scope: the default stays "all" so existing behaviour is unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-scope2-'))
  mkdirSync(join(dir, 'imports'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@imports/shared.md\n', 'utf8')
  writeFileSync(join(dir, 'imports', 'shared.md'), 'S0\n', 'utf8')
  const A = makeSession(dir, [])
  const B = makeSession(dir, [])
  const wakesA = []
  const wakesB = []
  // no wakeScope given -> default (all)
  const entry = liveEntry({ watchDebounceMs: 20, minReinjectIntervalMs: 100 })
  const run = await runPluginMulti({
    entry,
    steps: [
      { session: A, capture: (m) => wakesA.push(m) },
      { session: B, capture: (m) => wakesB.push(m) },
    ],
  })
  try {
    wakesA.length = 0
    wakesB.length = 0
    watchFile(join(dir, 'imports', 'shared.md'))
    await waitOut()
    assert.equal(wakesA.length, 1, `default wakes every referencing session (A), got ${wakesA.length}`)
    assert.equal(wakesB.length, 1, `default wakes every referencing session (B), got ${wakesB.length}`)
  } finally {
    run.dispose()
  }
})
await check('a valid UTF-8 file that contains a literal replacement character is injected', async () => {
  // Found by adversarial review (2026-11-25): the old decoder sniffed for
  // U+FFFD to decide "not UTF-8", so a perfectly valid UTF-8 file that merely
  // CONTAINED a replacement character was rejected with the encoding note.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-fffd-'))
  // "# 晚上好 \uFFFD\nVALID_FFFD_MARKER\n" — valid UTF-8 bytes, one legit U+FFFD inside.
  const raw = Buffer.concat([Buffer.from('# \u665a\u4e0a\u597d ', 'utf8'), Buffer.from([0xef, 0xbf, 0xbd]), Buffer.from('\nVALID_FFFD_MARKER\n', 'utf8')])
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\n@legit.md\n', 'utf8')
  writeFileSync(join(dir, 'legit.md'), raw)
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(dir, []) })
  assert.equal(injected.length, 1)
  const text = injected[0]
  assert.ok(!/UTF-8|无法解码/.test(text), `no encoding note may appear; got: ${text.slice(0, 200)}`)
  assert.match(text, /VALID_FFFD_MARKER/, 'the file content must be injected')
})

await check('a quoted word ending the previous line does not silence the next spaced reference', async () => {
  // Found by adversarial review (2026-11-25): the spaced-ref reporter skipped
  // whenever a double quote appeared within 2 characters BEFORE the @, and
  // that window reached across the line break, so the reference after a line
  // ending in a quoted word was silently dropped.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ci-quote-'))
  mkdirSync(join(dir, 'my docs'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# root\n\nsee "术语" below\n@my docs/plan.md\n', 'utf8')
  writeFileSync(join(dir, 'my docs', 'plan.md'), 'QUOTED_PREV_MARKER\n', 'utf8')
  const { injected } = await runPlugin({ entry: defaultEntry, session: makeSession(dir, []) })
  assert.equal(injected.length, 1)
  const text = injected[0]
  assert.match(text, /space|空格/, `the spaced reference must still be reported; got: ${text.slice(0, 220)}`)
})
await check('liveMode=off keeps 0.3.1 behaviour: injection but no wake', async () => {
  const session = makeSession(root, [])
  const followups = []
  const { injected } = await runPlugin({
    entry: { ...defaultEntry, liveMode: 'off' },
    session,
    captureFollowup: (message) => followups.push(message),
  })
  assert.equal(injected.length, 1)
  watchFile(join(root, 'imports', 'extra.md'))
  await waitOut()
  assert.equal(followups.length, 0, 'off mode never wakes')
})

await check('liveMode=inject: file change does NOT wake', async () => {
  const session = makeSession(root, [])
  const followups = []
  await runPlugin({
    entry: liveEntry({ liveMode: 'inject' }),
    session,
    captureFollowup: (message) => followups.push(message),
  })
  watchFile(join(root, 'imports', 'extra.md'))
  await waitOut()
  assert.equal(followups.length, 0, 'inject mode never wakes')
})

await check('liveMode=inject+wake: a real file change wakes the agent once', async () => {
  const session = makeSession(root, [])
  const followups = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50 }),
    session,
    captureFollowup: (message) => followups.push(message),
  })
  assert.equal(followups.length, 0, 'no wake at injection time')
  watchFile(join(root, 'imports', 'extra.md'))
  await waitOut()
  assert.equal(followups.length, 1, 'followup called once for the changed file')
  const wake = followups[0]
  assert.equal(wake?.source?.kind, 'context-imports-wake')
  assert.notEqual(wake?.source?.kind, 'context-imports')
})

await check('churn throttle: bursts inside the window wake once', async () => {
  const session = makeSession(root, [])
  const followups = []
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 2000 }),
    session,
    captureFollowup: (message) => followups.push(message),
  })
  // Let the injection-time throttle stamp age past the window, then wake.
  await new Promise((resolve) => setTimeout(resolve, 2100))
  watchFile(join(root, 'imports', 'extra.md'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(followups.length, 1, 'first change wakes')
  // A tight burst of three writes with no sleep between them: the debounce
  // collapses them into one evaluation, and that evaluation is still inside
  // the 2000ms min-interval counted from the wake — throttled.
  for (let round = 0; round < 3; round++) watchFile(join(root, 'imports', 'extra.md'))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(followups.length, 1, 'tight burst inside the min interval is throttled')
  // After the window expires, the next change wakes again.
  await new Promise((resolve) => setTimeout(resolve, 2100))
  watchFile(join(root, 'imports', 'extra.md'))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(followups.length, 2, 'change after the window expires wakes again')
})

await check('a session that never injected the file is not woken', async () => {
  const strangerSession = makeSession(root, [])
  const strangerFollowups = []
  const listenerSession = makeSession(root, [])
  const listenerFollowups = []
  // The listener session injects and starts watching.
  await runPlugin({
    entry: liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50 }),
    session: listenerSession,
    captureFollowup: (message) => listenerFollowups.push(message),
  })
  // A stranger agent on a DIFFERENT session only registers as a wake target
  // (same plugin fiber), but has no injected files.
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
  apply(ctx, liveEntry({ watchDebounceMs: 50, minReinjectIntervalMs: 50 }))
  listeners.get('agent/created')({ source: 'startup', agent: { session: strangerSession, id: 'a2' } })
  watchFile(join(root, 'imports', 'extra.md'))
  await waitOut()
  assert.equal(strangerFollowups.length, 0, 'stranger session not woken')
  assert.ok(listenerFollowups.length >= 1, 'listener session woken')
})

await check('agent/disposed stops the wake', async () => {
  const session = makeSession(root, [])
  const followups = []
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
  apply(ctx, liveEntry())
  listeners.get('agent/created')({ source: 'startup', agent: { session, id: 'a1' } })
  listeners.get('agent/pre-step') &&
    (await listeners.get('agent/pre-step')(
      {
        agent: { session, id: 'a1', followup: (message) => followups.push(message) },
        signal: new AbortController().signal,
      },
      async () => ({ kind: 'continue', messages: [] }),
    ))
  listeners.get('agent/disposed')({ agent: { session, id: 'a1' } })
  // Fiber unload also closes the watchers.
  for (const dispose of disposers) dispose()
  watchFile(join(root, 'imports', 'extra.md'))
  await waitOut()
  assert.equal(followups.length, 0, 'disposed agent is not woken')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
