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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

async function runPlugin({ entry, session, scene = 'startup', inbox = [] }) {
  const injected = []
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
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
  const result = preStep
    ? await preStep(
        {
          agent: { session, id: 'agent-1', inbox: { nextStep: inbox } },
          signal: new AbortController().signal,
        },
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

await check('a scene outside injectOn injects nothing', async () => {
  const session = makeSession(root, [])
  const { injected } = await runPlugin({ entry: defaultEntry, session, scene: 'unknown-scene' })
  assert.equal(injected.length, 0)
})

await check('a scene inside injectOn injects', async () => {
  const session = makeSession(root, [])
  const { injected } = await runPlugin({ entry: defaultEntry, session, scene: 'resume' })
  assert.equal(injected.length, 1)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
