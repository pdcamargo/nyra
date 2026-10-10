import { describe, expect, it } from 'vitest'
import { artboardMarkup, defaultTheme, FORMAT_VERSION, hash, type Theme } from '@nyra/design'
import { compileOffThread } from '../../renderer/src/lib/designCompile'
import { drawAll, drawnOf, remember } from '../../renderer/src/lib/designMarkup'
import { designHashes } from '../../renderer/src/store/designActivity'

const text = JSON.stringify({
  schema: FORMAT_VERSION,
  name: 'Markup',
  artboards: ['one', 'two'].map((id) => ({
    id,
    name: id,
    size: { width: 320, height: 200 },
    root: { id: 'root', type: 'box', children: [{ id: 'label', type: 'text', value: `Board ${id}` }] }
  }))
})

async function compiled() {
  const out = await compileOffThread(text)
  if (!out.ok) throw new Error(out.message)
  return out
}

describe('artboard markup', () => {
  it('arrives with the compile, the same markup the panel would have drawn', async () => {
    const { doc, theme } = await compiled()
    for (const a of doc.artboards) {
      const drawn = drawnOf(a, theme)
      expect(drawn.markup).toBe(artboardMarkup(a, theme))
      expect(drawn.hash).toBe(hash(drawn.markup))
    }
    expect(designHashes(doc, theme)).toEqual(
      Object.fromEntries(doc.artboards.map((a) => [a.id, hash(artboardMarkup(a, theme))]))
    )
  })

  it('is read, not drawn again, for the theme it was drawn with', async () => {
    const { doc, theme } = await compiled()
    const [a] = doc.artboards
    remember(doc, theme, { [a.id]: { markup: '<i>filed</i>', hash: 'filed' } })
    expect(drawnOf(a, theme)).toMatchObject({ markup: '<i>filed</i>', hash: 'filed' })
  })

  it('is drawn again for any other theme', async () => {
    const { doc, theme } = await compiled()
    const [a] = doc.artboards
    remember(doc, theme, { [a.id]: { markup: '<i>filed</i>', hash: 'filed' } })
    const other: Theme = { ...defaultTheme }
    expect(drawnOf(a, other).markup).toBe(artboardMarkup(a, other))
  })

  it('draws only the artboards a save changed', async () => {
    const { doc, theme } = await compiled()
    const before = drawAll(doc, theme)
    const [one, two] = doc.artboards
    const edited = { ...doc, artboards: [one, { ...two, name: 'two, renamed' }] }
    const after = drawAll(edited, theme)
    expect(after.one).toBe(before.one)
    expect(after.two).not.toBe(before.two)
    expect(after.two.markup).toBe(artboardMarkup(edited.artboards[1], theme))
  })

  it('draws again under another theme', async () => {
    const { doc, theme } = await compiled()
    const before = drawAll(doc, theme)
    expect(drawAll(doc, { ...theme, name: 'other' } as Theme).one).not.toBe(before.one)
  })
})
