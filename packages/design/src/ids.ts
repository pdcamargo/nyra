/**
 * Node identity. The four invariants that keep an inspector unblocked hang on
 * this file, so it is deliberately boring and explicit.
 *
 *   authored address  `settings-general#title`   scope + id, what a patch names
 *   resolved id       `settings-general#save/label`  instance path + inner id
 *
 * An authored id may not contain `#` or `/` (enforced by `idSchema`), so both
 * forms parse unambiguously and a component used twice never collides.
 */
export type Address = { scope: string; id: string }

export const SCOPE_SEP = '#'
export const PATH_SEP = '/'

export const address = (scope: string, id: string): string => `${scope}${SCOPE_SEP}${id}`

export function parseAddress(s: string): Address {
  const at = s.indexOf(SCOPE_SEP)
  if (at < 0) throw new Error(`not an address: "${s}" (expected scope${SCOPE_SEP}id)`)
  return { scope: s.slice(0, at), id: s.slice(at + 1) }
}

export const sameAddress = (a: Address, b: Address): boolean =>
  a.scope === b.scope && a.id === b.id

/** `settings-general#save/label` — the instance path, then the authored id. */
export const resolvedId = (artboard: string, path: readonly string[], id: string): string =>
  address(artboard, [...path, id].join(PATH_SEP))
