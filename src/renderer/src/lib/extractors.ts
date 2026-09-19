/**
 * How a `setVars` extractor spells itself.
 *
 * The engine parses `json:path`, `regex:pattern` and `lines:1-5`, and treats
 * anything else as the raw output. The inspector offers those four as a select,
 * so it needs to read a stored string back into one and write a fresh one out.
 */
/** `json:a.b` reads as `json`; anything without a prefix is the raw output. */
export function extractorKind(extractor: string): string {
  const prefix = extractor.split(':')[0]
  return ['json', 'regex', 'lines'].includes(prefix) ? prefix : 'raw'
}

/** A starting point for each kind, so picking one leaves something editable. */
export function extractorTemplate(kind: string): string {
  switch (kind) {
    case 'json':
      return 'json:'
    case 'regex':
      return 'regex:'
    case 'lines':
      return 'lines:1-5'
    default:
      return ''
  }
}
