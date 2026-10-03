import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FORMAT_VERSION, loadTokens } from '../src'
import { defaultTokensJson } from '../src/theme/defaultTokens'

describe('the default tokens a new system starts from', () => {
  // Rust seeds every new system with this file; regenerate it with
  // `npx vite-node packages/design/scripts/generate-default-tokens.mts`.
  it('are current with the built-in theme', () => {
    expect(readFileSync(resolve(__dirname, '../default-tokens.json'), 'utf8')).toBe(defaultTokensJson())
  })

  it('load as valid tokens', () => {
    const r = loadTokens(JSON.parse(defaultTokensJson()))
    expect(r.ok ? [] : r.issues).toEqual([])
  })

  // Rust writes new manifests and tokens at its own FORMAT. It must be this one.
  it('Rust writes the same format version the package reads', () => {
    const rust = readFileSync(resolve(__dirname, '../../../src-tauri/src/design_systems.rs'), 'utf8')
    expect(rust).toMatch(new RegExp(`pub const FORMAT: u32 = ${FORMAT_VERSION};`))
  })
})
