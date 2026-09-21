/**
 * Compile a document written outside this repo and report exactly what the
 * validator says about it — the fresh-Claude test's scoring sheet.
 */
import { readFileSync } from 'node:fs'
import { compile, validate } from '../src/pipeline'
import { PROPS } from '../src/registry/props'
import type { PropName } from '../src/registry/types'
import type { DocNode } from '../src/schema'
import { childrenOf, isUseNode } from '../src/schema'

const file = process.argv[2]
const raw = JSON.parse(readFileSync(file, 'utf8'))

const v = validate(raw)
console.log(`parses: ${v.ok}`)
if (!v.ok) {
  for (const i of v.issues.slice(0, 12)) {
    console.log(`  [${i.severity}] ${i.code}: ${i.message}${i.path ? ` @ ${i.path.join('.')}` : ''}`)
  }
  process.exit(0)
}

const warnings = v.issues.filter((i) => i.severity === 'warning')
console.log(`warnings: ${warnings.length}`)
for (const w of warnings.slice(0, 10)) console.log(`  ${w.code}: ${w.message} @ ${w.at?.scope}#${w.at?.id}`)

const { doc } = compile(raw)
console.log(`artboards: ${doc.artboards.map((a) => `${a.name} ${a.size.width}x${a.size.height}`).join(', ')}`)
console.log(`components: ${Object.keys(v.doc.components ?? {}).join(', ') || '(none)'}`)

// Which of the vocabulary it actually reached for.
const used = new Set<string>()
let nodes = 0
let instances = 0
const walk = (n: DocNode): void => {
  nodes++
  if (isUseNode(n)) instances++
  for (const k of Object.keys(n)) if (k in PROPS) used.add(k)
  childrenOf(n).forEach(walk)
}
for (const a of v.doc.artboards) walk(a.root)
for (const c of Object.values(v.doc.components ?? {})) walk(c.root)

const all = Object.keys(PROPS) as PropName[]
console.log(`nodes: ${nodes}, component instances: ${instances}`)
console.log(`properties used (${used.size}/${all.length}): ${[...used].sort().join(' ')}`)
console.log(`never reached for: ${all.filter((p) => !used.has(p)).join(' ')}`)
