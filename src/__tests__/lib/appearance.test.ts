import { afterEach, describe, expect, it } from 'vitest'
import {
  BUNDLED_CODE_FONT,
  BUNDLED_UI_FONT,
  applyAppearance,
  codeFontStack,
  fontStack,
  uiFontStack
} from '@renderer/lib/appearance'

describe('fontStack', () => {
  it('is the fallback alone when nothing is chosen', () => {
    expect(fontStack('', 'serif')).toBe('serif')
    expect(fontStack('   ', 'serif')).toBe('serif')
  })

  it('quotes the family and keeps the fallback behind it', () => {
    expect(fontStack('Helvetica Neue', 'serif')).toBe('"Helvetica Neue", serif')
  })

  // The name comes from the user's own machine, but it still ends up inside a
  // CSS string — a family called `a", monospace; x` must not close the quote.
  it('strips quotes and backslashes out of the name', () => {
    expect(fontStack('a", monospace', 'serif')).toBe('"a, monospace", serif')
    expect(fontStack('back\\slash', 'serif')).toBe('"backslash", serif')
  })

  it('anchors the bundled faces', () => {
    expect(uiFontStack('')).toContain(BUNDLED_UI_FONT)
    expect(codeFontStack('')).toContain(BUNDLED_CODE_FONT)
    expect(uiFontStack('Georgia')).toBe(`"Georgia", ${uiFontStack('')}`)
  })
})

describe('applyAppearance', () => {
  afterEach(() => document.documentElement.removeAttribute('style'))

  const read = (name: string): string => document.documentElement.style.getPropertyValue(name)

  it('writes every variable onto the document', () => {
    applyAppearance({
      uiFont: 'Georgia',
      uiFontWeight: 500,
      contentFont: '',
      contentFontWeight: 300,
      codeFont: 'Menlo',
      codeFontWeight: 600,
      contentFontSize: 17,
      uiFontSize: 14
    })

    expect(read('--font-sans')).toBe(uiFontStack('Georgia'))
    expect(read('--font-mono')).toBe(codeFontStack('Menlo'))
    expect(read('--ui-font-weight')).toBe('500')
    expect(read('--content-font-weight')).toBe('300')
    expect(read('--code-font-weight')).toBe('600')
    expect(read('--content-font-size')).toBe('17px')
    // Independent of the conversation's size: bumping the message text used to
    // leave the project rail exactly as small as it was.
    expect(read('--ui-font-size')).toBe('14px')
  })

  it('falls the content face back to the UI face, not to the bundled default', () => {
    applyAppearance({
      uiFont: 'Georgia',
      uiFontWeight: 400,
      contentFont: '',
      contentFontWeight: 400,
      codeFont: '',
      codeFontWeight: 400,
      contentFontSize: 15,
      uiFontSize: 13
    })
    expect(read('--font-content')).toBe(uiFontStack('Georgia'))
  })
})
