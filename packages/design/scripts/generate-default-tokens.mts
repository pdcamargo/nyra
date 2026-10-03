/**
 * The built-in theme as a `tokens.json`, for Rust to seed new design systems
 * with (`design_systems.rs` include_str!s it). Generated rather than written so
 * the two can never disagree; `tokens.test.ts` fails if this file is stale.
 *
 *   npx vite-node packages/design/scripts/generate-default-tokens.mts
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultTokensJson } from '../src/theme/defaultTokens'

const out = resolve(import.meta.dirname, '../default-tokens.json')
writeFileSync(out, defaultTokensJson())
console.log(`wrote ${out}`)
