import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The inspector's timeout copy against the engine that enforces it.
 *
 * The hint tells someone what blank means and what the ceiling is, and it is a
 * separate literal from the Rust constant. A hint that says two minutes while
 * the engine allows ten is worse than no hint — this is the whole reason the
 * duplication is acceptable.
 */
const rust = readFileSync(resolve(__dirname, '../../../src-tauri/src/workflow/engine.rs'), 'utf8')
const canvas = readFileSync(
  resolve(__dirname, '../../renderer/src/components/WorkflowCanvas.tsx'),
  'utf8'
)

const secs = (name: string): number => {
  const hit = new RegExp(`const ${name}: Duration = Duration::from_secs\\(([^)]+)\\)`).exec(rust)
  if (!hit) throw new Error(`${name} is not in engine.rs any more`)
  // `60 * 60` is written out in the Rust, so evaluate the arithmetic.
  return hit[1].split('*').reduce((a, b) => a * Number(b.trim()), 1)
}

describe('the script timeout the inspector promises', () => {
  it('matches the default the engine applies', () => {
    const shown = /const SCRIPT_TIMEOUT_SECONDS = (\d+)/.exec(canvas)?.[1]
    expect(Number(shown)).toBe(secs('SCRIPT_TIMEOUT'))
  })

  it('matches the ceiling the engine clamps to', () => {
    const shown = /const SCRIPT_TIMEOUT_MAX_SECONDS = (\d+)/.exec(canvas)?.[1]
    expect(Number(shown)).toBe(secs('SCRIPT_TIMEOUT_MAX'))
  })

  /**
   * The field was carried through on save and editable nowhere, so the only way
   * to give a node longer was to hand-edit the JSON in ~/.nyra/workflows. A
   * release flow's build node inherited the two-minute default as a result.
   */
  it('is editable from the inspector, not only preserved on save', () => {
    expect(canvas).toMatch(/label="Timeout"/)
    expect(canvas).toMatch(/timeoutMs: Number\.isFinite/)
  })

  it('treats a blank field as the default rather than as zero', () => {
    // `timeoutMs: 0` would mean "time out immediately", which no one means.
    expect(canvas).toMatch(/seconds > 0 \? seconds \* 1000 : undefined/)
  })
})

describe('a timed-out script', () => {
  it('is killed rather than abandoned', () => {
    expect(rust).toMatch(/\.kill_on_drop\(true\)/)
  })

  it('says how to give the node longer', () => {
    // The message appears exactly when the problem does, which is the only
    // moment anyone wants to know the remedy.
    expect(rust).toMatch(/set `timeoutMs` on the node/)
    expect(rust).toMatch(/was stopped/)
  })
})
