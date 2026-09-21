import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artboardHtml, hash, rasterRequest } from '../src/html'
import { compile } from '../src/pipeline'
import { apply, invert, type Patch } from '../src/patch'
import { validate } from '../src/pipeline'

const dir = resolve(__dirname, '../examples')
const files = readdirSync(dir).filter((f) => f.endsWith('.nyui.json')).sort()
const load = (f: string): unknown => JSON.parse(readFileSync(resolve(dir, f), 'utf8'))

describe('an artboard is self-contained HTML', () => {
  /**
   * The property that removes the localhost page from the render path: headless
   * Chromium is handed this string and needs nothing else. If a `<script>` or an
   * external stylesheet ever appears here, the sidecar needs a server and a
   * bundler again, so this is worth asserting over the whole corpus.
   */
  it.each(files)('%s emits no scripts and no external references', (f) => {
    const { doc, theme } = compile(load(f))
    for (const a of doc.artboards) {
      const html = artboardHtml(a, theme)
      expect(html).not.toContain('<script')
      const external = html.match(/(?:src|href)="(?!data:)[^"]*"/g) ?? []
      expect(external, `${a.id}: ${external.join(', ')}`).toHaveLength(0)
      expect(html).toContain('data-artboard=')
    }
  })

  it('carries the artboard element a rasteriser clips to', () => {
    const { doc, theme } = compile(load('login.nyui.json'))
    expect(artboardHtml(doc.artboards[0], theme)).toContain('data-artboard="login"')
  })

  it('escapes a name rather than letting it close the title', () => {
    const { doc, theme } = compile(load('login.nyui.json'))
    const html = artboardHtml({ ...doc.artboards[0], name: '</title><script>x' }, theme)
    expect(html).not.toContain('<script>x')
    expect(html).toContain('&lt;/title&gt;')
  })
})

describe('the raster cache key', () => {
  it('is stable for the same resolved artboard', () => {
    const a = compile(load('login.nyui.json'))
    const b = compile(load('login.nyui.json'))
    expect(rasterRequest(a.doc.artboards[0], a.theme).key).toBe(
      rasterRequest(b.doc.artboards[0], b.theme).key
    )
  })

  it('survives reformatting the source file', () => {
    // The key hashes the RESOLVED artboard, so whitespace and key order in the
    // document cannot invalidate a raster.
    const raw = load('login.nyui.json')
    const reformatted = JSON.parse(JSON.stringify(raw, null, 4))
    const a = compile(raw)
    const b = compile(reformatted)
    expect(rasterRequest(a.doc.artboards[0], a.theme).key).toBe(
      rasterRequest(b.doc.artboards[0], b.theme).key
    )
  })

  it('changes when the design changes', () => {
    const raw = validate(load('login.nyui.json'))
    if (!raw.ok) throw new Error('fixture')
    const patch: Patch = {
      op: 'setProp',
      at: { scope: 'login', id: 'card' },
      prop: 'padding',
      value: '$space.4'
    }
    const a = compile(raw.doc)
    const b = compile(apply(raw.doc, patch))
    expect(rasterRequest(a.doc.artboards[0], a.theme).key).not.toBe(
      rasterRequest(b.doc.artboards[0], b.theme).key
    )
  })

  it('distinguishes scales, so a thumbnail is not served as a full render', () => {
    const { doc, theme } = compile(load('login.nyui.json'))
    expect(rasterRequest(doc.artboards[0], theme, 1).key).not.toBe(
      rasterRequest(doc.artboards[0], theme, 2).key
    )
  })

  it('hashes deterministically and without collision across the corpus', () => {
    const keys = new Set<string>()
    for (const f of files) {
      const { doc, theme } = compile(load(f))
      for (const a of doc.artboards) keys.add(rasterRequest(a, theme).key)
    }
    expect(keys.size).toBe(files.length)
    expect(hash('a')).toBe(hash('a'))
    expect(hash('a')).not.toBe(hash('b'))
  })
})

describe('artboard position', () => {
  const doc = (position?: unknown): unknown => ({
    schema: 1,
    name: 'T',
    artboards: [
      {
        id: 'a',
        name: 'A',
        size: { width: 200, height: 200 },
        ...(position !== undefined ? { position } : {}),
        root: { id: 'r', type: 'box', layout: 'stack' }
      }
    ]
  })

  it('is optional, and survives compilation when present', () => {
    expect(validate(doc()).ok).toBe(true)
    const { doc: out } = compile(doc({ x: 120, y: -40 }))
    expect(out.artboards[0].position).toEqual({ x: 120, y: -40 })
  })

  it('rejects a half-specified position', () => {
    expect(validate(doc({ x: 10 })).ok).toBe(false)
    expect(validate(doc({ x: 10, y: 10, z: 10 })).ok).toBe(false)
  })

  it('moves and un-places, invertibly', () => {
    const v = validate(doc({ x: 0, y: 0 }))
    if (!v.ok) throw new Error('fixture')
    for (const patch of [
      { op: 'moveArtboard', id: 'a', position: { x: 900, y: 40 } },
      { op: 'moveArtboard', id: 'a', position: undefined }
    ] as Patch[]) {
      const undo = invert(v.doc, patch)
      expect(apply(apply(v.doc, patch), undo)).toEqual(v.doc)
    }
  })
})
