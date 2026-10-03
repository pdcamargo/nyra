import type { Migration } from './index'

/**
 * v1 → v2: slots, `meta`, per-artboard `mode`, component `description`.
 *
 * Everything v2 adds is optional, so a v1 document is already a valid v2
 * document and this step only moves the number. It still has to exist: the
 * number is what lets an older Nyra refuse a file with slots by name ("made
 * with a newer Nyra") instead of failing on an unknown key.
 */
export const slotsMetaModes: Migration = {
  from: 1,
  summary: 'slots, meta and artboard modes were added; nothing in the file changes',
  migrate: (doc) => ({ doc })
}
