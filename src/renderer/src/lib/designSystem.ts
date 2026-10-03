/**
 * A design system, read: its files, what each one holds, and everything a
 * single file needs to be compiled as part of it.
 *
 * Rust lists the files and owns the registry; this reads and understands them.
 * One cache per system, keyed by each file's size and mtime, so a poll that
 * finds one file changed re-reads that file and nothing else — a 60-file
 * system costs one listing per tick, not sixty reads.
 *
 * The outline is built from raw JSON, without compiling: the nav, the page
 * placeholders and Claude's digest need names, props and sizes, and none of
 * that should wait on, or fail with, a file that does not compile right now.
 */
import {
  buildRegistry,
  formatVersionOf,
  FORMAT_VERSION,
  serializeDocument,
  upgrade,
  loadTokens,
  lookupToken,
  modesOf,
  themeFor,
  type DesignDocument,
  type DesignMeta,
  type Issue,
  type Tokens
} from '@nyra/design'
import type { SystemEntry, SystemFileInfo, SystemFileKind } from './api-types'
import type { SystemCompileContext } from './designCompile'

export type OutlineProp = { name: string; type: string; of?: string[]; default?: unknown; description?: string }

export type OutlineComponent = { name: string; description?: string; props: OutlineProp[] }

export type OutlineArtboard = { id: string; name: string; width: number; height: number | 'auto'; mode?: string }

export type OutlineFile = {
  rel: string
  path: string
  kind: Extract<SystemFileKind, 'component' | 'pattern' | 'screen'>
  /** The document's `name`, or the file name when it has none. */
  name: string
  meta?: DesignMeta
  components: OutlineComponent[]
  artboards: OutlineArtboard[]
  /** Set when the file could not be read as JSON at all. */
  error?: string
  /** The format version the file is written in, when older than current. */
  olderFormat?: number
  /** Components this file draws instances of, anywhere in it. */
  uses: string[]
  /** How many instances of each of those it draws. */
  useCounts: Record<string, number>
  size: number
  mtimeMs: number
}

export type Guideline = { rel: string; path: string; title: string; text: string }

/** A lucide icon some file of the system draws, and the files that draw it. */
export type SystemIcon = { name: string; files: string[] }

export type LoadedSystem = {
  entry: SystemEntry
  manifest: { name: string; description: string }
  tokens: {
    /** The parsed `tokens.json`, or null when there is none (the built-in theme). */
    raw: unknown | null
    parsed: Tokens | null
    issues: string[]
    modes: string[]
  }
  files: OutlineFile[]
  guidelines: Guideline[]
  /** Every icon drawn anywhere in the system, by name. */
  icons: SystemIcon[]
  /** Every file's components: the shared namespace, for compiles. */
  components: { file: string; components: Record<string, unknown> }[]
  /** Names defined in more than one file. */
  registryIssues: Issue[]
  /** Changes when any file does. */
  stamp: string
}

/** One file of a system as read: its text, its JSON, or why neither. */
export type Cached = { info: SystemFileInfo; text: string | null; json: unknown; error?: string }

const caches = new Map<string, Map<string, Cached>>()

/** By id *and* folder: a worktree's copy of a system is the same system with
 *  different files, and the two must not share what was read. */
const cacheKey = (entry: SystemEntry): string => `${entry.id}@${entry.root}`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function fileName(rel: string): string {
  const base = rel.split('/').pop() ?? rel
  return base.replace(/\.nyui\.json$/, '').replace(/\.md$/, '')
}

/** Read (or reuse) every file in the system. */
export async function loadSystem(entry: SystemEntry): Promise<LoadedSystem> {
  const listing = await window.api.designSystem.files(entry.id, entry.root)
  if (!listing.ok || !listing.files) throw new Error(listing.error ?? `could not list the files of ${entry.name}`)

  const cache = caches.get(cacheKey(entry)) ?? new Map<string, Cached>()
  caches.set(cacheKey(entry), cache)
  const live = new Set(listing.files.map((f) => f.rel))
  for (const rel of [...cache.keys()]) if (!live.has(rel)) cache.delete(rel)

  await Promise.all(
    listing.files.map(async (info) => {
      const hit = cache.get(info.rel)
      if (hit && hit.info.size === info.size && hit.info.mtimeMs === info.mtimeMs) return
      const read = await window.api.design.read(info.path)
      if (read.kind !== 'text') {
        cache.set(info.rel, { info, text: null, json: null, error: read.kind === 'error' ? read.message : read.kind })
        return
      }
      if (info.kind === 'guideline') {
        cache.set(info.rel, { info, text: read.content, json: null })
        return
      }
      try {
        cache.set(info.rel, { info, text: read.content, json: JSON.parse(read.content) })
      } catch (e) {
        cache.set(info.rel, { info, text: read.content, json: null, error: e instanceof Error ? e.message : String(e) })
      }
    })
  )

  return assemble(entry, [...cache.values()].sort((a, b) => a.info.rel.localeCompare(b.info.rel)))
}

/** Forget what was read, so the next load reads everything again. */
export function dropSystemCache(id?: string): void {
  if (!id) return caches.clear()
  for (const key of [...caches.keys()]) if (key.startsWith(`${id}@`)) caches.delete(key)
}

/** Exported for the tests: the system from files already read. */
export function assemble(entry: SystemEntry, files: Cached[]): LoadedSystem {
  const manifestFile = files.find((f) => f.info.kind === 'manifest')
  const m = isObject(manifestFile?.json) ? manifestFile.json : {}
  const manifest = {
    name: typeof m.name === 'string' ? m.name : entry.name,
    description: typeof m.description === 'string' ? m.description : ''
  }

  const tokensFile = files.find((f) => f.info.kind === 'tokens')
  const tokens: LoadedSystem['tokens'] = { raw: null, parsed: null, issues: [], modes: [] }
  if (tokensFile) {
    tokens.raw = tokensFile.json
    if (tokensFile.error) tokens.issues.push(`tokens.json: ${tokensFile.error}`)
    else {
      const loaded = loadTokens(tokensFile.json)
      if (loaded.ok) {
        tokens.parsed = loaded.tokens
        tokens.modes = modesOf(loaded.tokens)
      } else tokens.issues.push(...loaded.issues)
    }
  }

  const members: OutlineFile[] = []
  const components: LoadedSystem['components'] = []
  for (const f of files) {
    if (!isMember(f)) continue
    members.push(outline(f))
    if (isObject(f.json) && isObject(f.json.components)) {
      components.push({ file: f.info.rel, components: f.json.components as Record<string, unknown> })
    }
  }
  members.sort(byNav)

  const guidelines: Guideline[] = files
    .filter((f) => f.info.kind === 'guideline' && f.text !== null)
    .map((f) => ({
      rel: f.info.rel,
      path: f.info.path,
      title: /^#\s+(.+)$/m.exec(f.text ?? '')?.[1]?.trim() ?? fileName(f.info.rel),
      text: f.text ?? ''
    }))

  const { issues: registryIssues } = buildRegistry(
    components.map((c) => ({ file: c.file, doc: { components: c.components } as unknown as DesignDocument }))
  )

  return {
    entry,
    manifest,
    tokens,
    files: members,
    guidelines,
    icons: systemIcons(files.filter(isMember)),
    components,
    registryIssues,
    stamp: files.map((f) => `${f.info.rel}:${f.info.size}:${f.info.mtimeMs}`).join('|')
  }
}

const isMember = (f: Cached): boolean =>
  f.info.kind === 'component' || f.info.kind === 'pattern' || f.info.kind === 'screen'

const KIND_ORDER = { component: 0, pattern: 1, screen: 2 } as const

function byNav(a: OutlineFile, b: OutlineFile): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    (a.meta?.group ?? '').localeCompare(b.meta?.group ?? '') ||
    (a.meta?.order ?? Infinity) - (b.meta?.order ?? Infinity) ||
    a.name.localeCompare(b.name)
  )
}

function outline(f: Cached): OutlineFile {
  const base: OutlineFile = {
    rel: f.info.rel,
    path: f.info.path,
    kind: f.info.kind as OutlineFile['kind'],
    name: fileName(f.info.rel),
    components: [],
    artboards: [],
    uses: [],
    useCounts: {},
    size: f.info.size,
    mtimeMs: f.info.mtimeMs
  }
  if (f.error || !isObject(f.json)) return { ...base, error: f.error ?? 'not a JSON object' }
  const doc = f.json
  if (typeof doc.name === 'string') base.name = doc.name
  if (isObject(doc.meta)) base.meta = doc.meta as DesignMeta
  const v = formatVersionOf(doc)
  if (v !== null && v < FORMAT_VERSION) base.olderFormat = v
  if (isObject(doc.components)) {
    base.components = Object.entries(doc.components).map(([name, def]) => {
      const d = isObject(def) ? def : {}
      const props = isObject(d.props) ? d.props : {}
      return {
        name,
        ...(typeof d.description === 'string' ? { description: d.description } : {}),
        props: Object.entries(props).map(([p, spec]) => {
          const s = isObject(spec) ? spec : {}
          const out: OutlineProp = { name: p, type: typeof s.type === 'string' ? s.type : '?' }
          if (Array.isArray(s.of)) out.of = s.of.filter((x): x is string => typeof x === 'string')
          if ('default' in s) out.default = s.default
          if (typeof s.description === 'string') out.description = s.description
          return out
        })
      }
    })
  }
  const counts = usesIn(doc)
  base.uses = [...counts.keys()].sort()
  base.useCounts = Object.fromEntries(counts)
  if (Array.isArray(doc.artboards)) {
    base.artboards = doc.artboards.filter(isObject).map((a) => {
      const size = isObject(a.size) ? a.size : {}
      const out: OutlineArtboard = {
        id: String(a.id ?? ''),
        name: String(a.name ?? a.id ?? ''),
        width: typeof size.width === 'number' ? size.width : 0,
        height: size.height === 'auto' ? 'auto' : typeof size.height === 'number' ? size.height : 0
      }
      if (typeof a.mode === 'string') out.mode = a.mode
      return out
    })
  }
  return base
}

/** Every `"use"` in a document, counted, walked as raw JSON: "used in" without compiling. */
function usesIn(v: unknown, out = new Map<string, number>()): Map<string, number> {
  if (Array.isArray(v)) for (const x of v) usesIn(x, out)
  else if (isObject(v)) {
    if (typeof v.use === 'string') out.set(v.use, (out.get(v.use) ?? 0) + 1)
    for (const x of Object.values(v)) usesIn(x, out)
  }
  return out
}

/** A file that draws a component, and how many times. */
export type UsedIn = { file: OutlineFile; count: number }

/**
 * Which files draw a component, directly or through a component that does, and
 * how many instances in each draw it: a screen with two ButtonGroups and one
 * Button counts three.
 */
export function usedIn(sys: LoadedSystem, component: string): UsedIn[] {
  const definedIn = new Map<string, string>()
  for (const f of sys.files) for (const c of f.components) definedIn.set(c.name, f.rel)
  // Components that use this one, transitively, so a screen drawing a
  // ButtonGroup counts as drawing a Button.
  const users = new Set([component])
  let grew = true
  while (grew) {
    grew = false
    for (const f of sys.files) {
      for (const c of f.components) {
        if (users.has(c.name)) continue
        // A component's own uses are the file's uses; close enough for this list.
        if (f.uses.some((u) => users.has(u) && u !== c.name)) {
          users.add(c.name)
          grew = true
        }
      }
    }
  }
  return sys.files
    .filter((f) => definedIn.get(component) !== f.rel)
    .map((file) => ({
      file,
      count: Object.entries(file.useCounts).reduce((n, [u, k]) => n + (users.has(u) ? k : 0), 0)
    }))
    .filter((u) => u.count > 0)
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Every string a value can come out as: a literal, or any case of a match. */
function stringsOf(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (isObject(v) && isObject(v.cases)) return [...Object.values(v.cases), v.default].flatMap(stringsOf)
  return []
}

/** Every node-like object in raw JSON: anything with a `type` or a `use`. */
function eachNode(v: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(v)) for (const x of v) eachNode(x, visit)
  else if (isObject(v)) {
    if (typeof v.type === 'string' || typeof v.use === 'string') visit(v)
    for (const x of Object.values(v)) eachNode(x, visit)
  }
}

/**
 * Every icon the system's files draw, read from raw JSON. An icon's name is
 * often a component prop — `IconButton`'s `icon` — so a prop that ends up as an
 * icon's name, directly or handed down through another component, counts its
 * instances' values, its default and its enum options too.
 */
function systemIcons(files: Cached[]): SystemIcon[] {
  const found = new Map<string, Set<string>>()
  const add = (name: string, rel: string): void => {
    if (!ICON_NAME.test(name)) return
    const at = found.get(name) ?? new Set<string>()
    at.add(rel)
    found.set(name, at)
  }
  const docs = files.filter((f) => isObject(f.json)) as (Cached & { json: Record<string, unknown> })[]

  // `Component.prop` keys whose value becomes an icon's name.
  const iconProps = new Set<string>()
  // `Outer.prop` handed to `Inner.prop` as `{ "prop": … }`.
  const handed: [from: string, to: string][] = []
  const options: { key: string; values: string[]; rel: string }[] = []
  for (const f of docs) {
    const defs = isObject(f.json.components) ? f.json.components : {}
    for (const [name, def] of Object.entries(defs)) {
      if (!isObject(def)) continue
      eachNode(def.root, (n) => {
        if (n.type === 'icon' && isObject(n.name) && typeof n.name.prop === 'string') iconProps.add(`${name}.${n.name.prop}`)
        if (typeof n.use === 'string' && isObject(n.props)) {
          for (const [k, v] of Object.entries(n.props)) {
            if (isObject(v) && typeof v.prop === 'string') handed.push([`${name}.${v.prop}`, `${n.use}.${k}`])
          }
        }
      })
      for (const [p, spec] of Object.entries(isObject(def.props) ? def.props : {})) {
        if (!isObject(spec)) continue
        const of = Array.isArray(spec.of) ? spec.of.filter((x): x is string => typeof x === 'string') : []
        options.push({ key: `${name}.${p}`, values: [...stringsOf(spec.default), ...of], rel: f.info.rel })
      }
    }
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const [from, to] of handed) {
      if (iconProps.has(to) && !iconProps.has(from)) {
        iconProps.add(from)
        grew = true
      }
    }
  }

  for (const f of docs) {
    eachNode(f.json, (n) => {
      if (n.type === 'icon') for (const s of stringsOf(n.name)) add(s, f.info.rel)
      if (typeof n.use === 'string' && isObject(n.props)) {
        for (const [k, v] of Object.entries(n.props)) {
          if (iconProps.has(`${n.use}.${k}`)) for (const s of stringsOf(v)) add(s, f.info.rel)
        }
      }
    })
  }
  for (const o of options) if (iconProps.has(o.key)) for (const s of o.values) add(s, o.rel)

  return [...found]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, rels]) => ({ name, files: [...rels].sort() }))
}

/** The text of one file as last read, for compiling without another read. */
export function systemFileText(entry: SystemEntry, rel: string): string | null {
  return caches.get(cacheKey(entry))?.get(rel)?.text ?? null
}

/** What one file of the system needs to compile, as plain data for the worker. */
export function compileContextFor(sys: LoadedSystem, rel: string, mode?: string): SystemCompileContext {
  const out: SystemCompileContext = {
    file: rel,
    components: sys.components,
    tokens: sys.tokens.parsed ? sys.tokens.raw : null,
    name: sys.manifest.name
  }
  if (mode) out.mode = mode
  return out
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

export type ContrastRow = {
  token: string
  /** What the alias points at, one step: `violet.600`. */
  ref: string | null
  hex: string | null
  /** Against `surface` (or `bg` when there is no surface). */
  ratio: number | null
  grade: 'AAA' | 'AA' | 'large' | 'none' | null
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function contrastRatio(a: string, b: string): number | null {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  if (!x || !y) return null
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

export const gradeOf = (ratio: number): ContrastRow['grade'] =>
  ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'large' : 'none'

/**
 * Every semantic colour (the aliases, not the ramps) with its contrast against
 * the system's surface, in one mode. What the Color page badges and what the
 * digest warns about — measured from the tokens, never asserted.
 */
export function semanticContrast(tokens: Tokens, mode?: string): ContrastRow[] {
  const theme = themeFor(tokens, mode)
  const colors = theme.color as Record<string, unknown>
  const resolve = (path: string): string | null => {
    try {
      const v = lookupToken(theme, path)
      return typeof v === 'string' ? v : null
    } catch {
      return null
    }
  }
  const surface = resolve('$color.surface') ?? resolve('$color.bg')
  return Object.entries(colors)
    .filter(([, v]) => typeof v === 'string' && v !== 'transparent')
    .map(([name, v]) => {
      const hex = resolve(`$color.${name}`)
      // `onAccent` is ink for the accent, so it is measured against the accent,
      // not the surface — white on white would otherwise read as a failure.
      const on = /^on([A-Z]\w*)$/.exec(name)
      const base = on ? (resolve(`$color.${on[1][0].toLowerCase()}${on[1].slice(1)}`) ?? surface) : surface
      const ratio = hex && base ? contrastRatio(hex, base) : null
      return {
        token: name,
        ref: typeof v === 'string' && v.startsWith('$color.') ? v.slice('$color.'.length) : null,
        hex,
        ratio,
        grade: ratio === null ? null : gradeOf(ratio)
      }
    })
}

/** Aliases whose names say they are for words, that are not readable as words. */
export function textContrastProblems(tokens: Tokens, mode?: string): ContrastRow[] {
  const forText = /^(text|on[A-Z]|accent$|danger$|success$|warning$|info$|link)/
  return semanticContrast(tokens, mode).filter(
    (r) => forText.test(r.token) && !/^on[A-Z]/.test(r.token) && r.ratio !== null && r.ratio < 4.5
  )
}

// ---------------------------------------------------------------------------
// The digest: what Claude reads about a system
// ---------------------------------------------------------------------------

const fmt = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

function propLine(p: OutlineProp): string {
  if (p.type === 'slot') return `${p.name} (slot)`
  const type = p.type === 'enum' && p.of ? p.of.join(' | ') : p.type
  return `${p.name}: ${type}${p.default !== undefined ? ` = ${fmt(p.default)}` : ''}`
}

/**
 * A compact, generated summary of the system: what Claude needs to design or
 * build with it. Generated every time from the files, never maintained by
 * hand, so it cannot drift from them. The same text, with frontmatter, is the
 * repo's project skill.
 */
export function systemDigest(sys: LoadedSystem): string {
  const lines: string[] = []
  const { manifest, tokens, files, guidelines, entry } = sys
  lines.push(`# ${manifest.name} design system`, '')
  if (manifest.description) lines.push(manifest.description, '')
  lines.push(
    `Lives at \`${entry.root}\`. Its files are Nyra Design documents (\`.nyui.json\`, format v${FORMAT_VERSION}): ` +
      'components in `components/`, compositions in `patterns/`, product screens in `screens/`, and the rules in `guidelines/`.',
    '',
    'Use its components by name and its tokens for every colour, size, radius and font — in Nyra designs and in code built from them. ' +
      'Every component in every file is available to every other file; do not redefine one locally.',
    ''
  )

  if (tokens.parsed) {
    const t = tokens.parsed
    const base = themeFor(t, undefined)
    lines.push(`## Tokens`, '', `Modes: ${tokens.modes.join(', ')} (\`${t.baseMode}\` is the base).`, '')
    const semantic = semanticContrast(t)
    if (semantic.length) {
      lines.push('Semantic colours (use these, not ramp steps):')
      for (const r of semantic) lines.push(`- \`$color.${r.token}\` → ${r.ref ?? r.hex ?? '?'}${r.hex && r.ref ? ` (${r.hex})` : ''}`)
      lines.push('')
    }
    const scale = (name: 'space' | 'radius' | 'shadow' | 'border' | 'font'): string[] => Object.keys(base[name])
    lines.push(`Type styles: ${scale('font').map((f) => {
      const b = base.font[f]
      return `\`$font.${f}\` ${b.size}/${b.weight}`
    }).join(', ')}.`)
    lines.push(`Space: ${scale('space').map((s) => `\`$space.${s}\` ${base.space[s]}`).join(', ')}.`)
    lines.push(`Radius: ${scale('radius').map((s) => `\`$radius.${s}\` ${base.radius[s]}`).join(', ')}.`)
    lines.push(`Shadows: ${scale('shadow').map((s) => `\`$shadow.${s}\``).join(', ')}. Borders: ${scale('border').map((s) => `\`$border.${s}\``).join(', ')}.`, '')
  } else if (tokens.issues.length) {
    lines.push('## Tokens', '', 'tokens.json does not load:', ...tokens.issues.map((i) => `- ${i}`), '')
  } else {
    lines.push('## Tokens', '', 'No tokens.json: files use the built-in theme.', '')
  }

  const section = (kind: OutlineFile['kind'], title: string): void => {
    const group = files.filter((f) => f.kind === kind)
    if (!group.length) return
    const count = group.reduce((n, f) => n + f.components.length, 0)
    lines.push(`## ${title}${kind === 'screen' ? '' : ` (${count})`}`, '')
    for (const f of group) {
      const status = f.meta?.status ? ` · ${f.meta.status}` : ''
      const where = `\`${f.rel}\`${f.meta?.group ? ` · ${f.meta.group}` : ''}${status}`
      if (f.error) {
        lines.push(`- ${f.name} — ${where} — **does not parse:** ${f.error}`)
        continue
      }
      if (kind === 'screen' || f.components.length === 0) {
        lines.push(`- ${f.name} — ${where} — artboards: ${f.artboards.map((a) => a.name).join(', ') || 'none'}`)
        continue
      }
      for (const c of f.components) {
        lines.push(`- **${c.name}** — ${where}${c.description ? ` — ${c.description}` : ''}`)
        if (c.props.length) lines.push(`  Props: ${c.props.map(propLine).join('; ')}.`)
      }
      if (f.meta?.usage?.do?.length) lines.push(`  Do: ${f.meta.usage.do.join(' ')}`)
      if (f.meta?.usage?.dont?.length) lines.push(`  Don't: ${f.meta.usage.dont.join(' ')}`)
    }
    lines.push('')
  }
  section('component', 'Components')
  section('pattern', 'Patterns')
  section('screen', 'Screens')

  if (guidelines.length) {
    lines.push('## Guidelines', '')
    for (const g of guidelines) lines.push(`- ${g.title} — \`${g.rel}\``)
    const brief = guidelines.find((g) => /(^|\/)brief\.md$/.test(g.rel))
    if (brief) lines.push('', '### Brief', '', brief.text.replace(/^#\s+.+\n+/, '').trim().slice(0, 4000))
    lines.push('')
  }

  const checks: string[] = []
  if (tokens.parsed) {
    for (const mode of tokens.modes) {
      for (const r of textContrastProblems(tokens.parsed, mode)) {
        checks.push(`\`$color.${r.token}\` is ${r.ratio!.toFixed(1)}:1 on the surface in ${mode} — below AA (4.5) for body text.`)
      }
    }
  }
  for (const i of sys.registryIssues) checks.push(i.message)
  for (const f of files) if (f.olderFormat) checks.push(`\`${f.rel}\` is format v${f.olderFormat}; upgrade it before editing.`)
  if (checks.length) lines.push('## Checks', '', ...checks.map((c) => `- ${c}`), '')

  return `${lines.join('\n').trim()}\n`
}

/** The digest as a Claude Code skill, for the repo. */
export function projectSkill(sys: LoadedSystem): string {
  const slug = sys.manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design'
  const front = [
    '---',
    `name: ${slug}-design-system`,
    `description: The ${sys.manifest.name} design system — its tokens, components and rules. Use for any UI work in this repo: designing screens, building components, or choosing colours, type and spacing.`,
    '---',
    '',
    '<!-- Generated by Nyra from the design system files. Edits here are overwritten; change the system instead. -->',
    ''
  ].join('\n')
  return `${front}${systemDigest(sys)}`
}

/**
 * Bring every file of a system to the current format, each original backed up
 * first; files already current are left alone. Returns what changed and the
 * folder the originals went to.
 */
export async function upgradeSystemFiles(entry: SystemEntry): Promise<{ upgraded: string[]; backup: string }> {
  const sys = await loadSystem(entry)
  const upgraded: string[] = []
  let backup = ''
  for (const f of sys.files.filter((x) => x.olderFormat !== undefined)) {
    const read = await window.api.design.read(f.path)
    if (read.kind !== 'text') continue
    const out = upgrade(JSON.parse(read.content))
    if (!out) continue
    const written = await window.api.design.writeUpgraded(f.path, serializeDocument(out.doc), out.from)
    if (!written.ok) throw new Error(written.error ?? `could not write ${f.rel}`)
    backup = written.backup ?? backup
    upgraded.push(`${f.rel}  v${out.from} → v${out.to}`)
  }
  return { upgraded, backup }
}
