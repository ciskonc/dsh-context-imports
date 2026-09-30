# dsh-context-imports — 注入取证检查器
#
# 用法：node scripts/check-injection.cjs <session.jsonl | session.v3.jsonl.zstd> [--verbose]
#
# 对指定会话日志断言（测试流程 F1-F6 的机器判定层）：
#   A1 注入消息恰好 1 份（user/message，source kind=context-imports 或旧形态 plugin/dsh-context-imports）
#   A2 注入块在 AGENTS.md（agent-instructions）与 skill-catalog 之后（seq 更大）
#   A3 包装无引导语（首行即 <system-reminder> + <file）
#   A4 注入块当前在活跃表面（surfaceOp 重放判定）
#
# .zstd 输入需 ZSTD 环境变量或 PATH 里有 zstd 可执行文件。
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const VERBOSE = process.argv.includes('--verbose')
const input = process.argv.find((a) => a.endsWith('.jsonl') || a.endsWith('.zstd'))
if (!input) {
  console.error('用法: node scripts/check-injection.cjs <session.jsonl|session.v3.jsonl.zstd> [--verbose]')
  process.exit(2)
}

let lines
if (input.endsWith('.zstd')) {
  const candidates = [process.env.ZSTD, 'zstd', 'C:/Users/Gamer/AppData/Local/Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin/zstd.exe'].filter(Boolean)
  let out
  for (const bin of candidates) {
    try {
      out = execFileSync(bin, ['-d', '-f', input, '-o', '-'], { maxBuffer: 256 * 1024 * 1024 })
      break
    } catch { /* try next */ }
  }
  if (!out) {
    console.error('无法解压 .zstd：请安装 zstd 或设 ZSTD 环境变量')
    process.exit(2)
  }
  lines = out.toString('utf8').split('\n').filter(Boolean)
} else {
  lines = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean)
}

const isOurs = (src) => {
  if (typeof src !== 'object' || src === null) return false
  return src.kind === 'context-imports' || (src.kind === 'plugin' && src.plugin === 'dsh-context-imports')
}

// 重放 surface（append/replace）
const surfaceSeqs = new Set()
const events = []
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  events.push(e)
  const op = e.surfaceOp
  if (!op) continue
  if (op === 'append') surfaceSeqs.add(e.seq)
  else if (typeof op === 'object' && op.op === 'replace') {
    for (let s = op.startSeq; s <= op.endSeq; s++) surfaceSeqs.delete(s)
    surfaceSeqs.add(e.seq)
  }
}

const injections = []
let agentsMdSeq = -1
let skillCatalogSeq = -1
for (const e of events) {
  if (e.type !== 'user/message') continue
  const src = e.data?.source
  if (isOurs(src)) {
    const text = e.data?.content?.[0]?.text ?? ''
    injections.push({ seq: e.seq, onSurface: surfaceSeqs.has(e.seq), firstLines: text.split('\n').slice(0, 2).join(' | ') })
  }
  if (src?.kind === 'agent-instructions' && src?.baseline) agentsMdSeq = Math.max(agentsMdSeq, e.seq)
  if (src?.kind === 'skill-catalog') skillCatalogSeq = Math.max(skillCatalogSeq, e.seq)
}

const failures = []
const visible = injections.filter((i) => i.onSurface)
if (visible.length !== 1) failures.push(`A1 活跃表面注入数=${visible.length}（期望 1）${visible.length ? '' : '；全部注入: ' + JSON.stringify(injections.map(i => i.seq))}`)
if (visible.length === 1) {
  const inj = visible[0]
  if (agentsMdSeq > 0 && inj.seq < agentsMdSeq) failures.push(`A2 注入 seq=${inj.seq} 在 AGENTS.md seq=${agentsMdSeq} 之前`)
  if (skillCatalogSeq > 0 && inj.seq < skillCatalogSeq) failures.push(`A2 注入 seq=${inj.seq} 在 skill-catalog seq=${skillCatalogSeq} 之前`)
  if (!/^<system-reminder>\s*<file /m.test(inj.firstLines.replace(/\s+/g, ' '))) {
    // 宽松判定：首行应是 <system-reminder>，第二行应是 <file
    const fl = inj.firstLines
    if (!fl.startsWith('<system-reminder>') || !fl.includes('<file ')) failures.push(`A3 包装异常: ${fl.slice(0, 80)}`)
  }
}

console.log(`会话事件 ${events.length} | 注入块 ${injections.length}（表面可见 ${visible.length}）`)
if (VERBOSE) for (const i of injections) console.log(`  seq=${i.seq} 表面=${i.onSurface ? '在' : '不在'} ${i.firstLines.slice(0, 60)}`)
if (failures.length) {
  console.log('FAIL:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('PASS')
