import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { inlineHtml, parseTable, splitRow } from '@renderer/lib/tablePreview'
import MarkdownPreview from '@renderer/components/files/MarkdownPreview'

describe('reading a table', () => {
  it('drops the outer pipes and keeps an escaped one', () => {
    expect(splitRow('| a | b \\| c | d |')).toEqual(['a', 'b | c', 'd'])
    expect(splitRow('a | b')).toEqual(['a', 'b'])
  })

  it('takes the alignment from the delimiter row', () => {
    const t = parseTable('| a | b | c | d |\n|---|:--|:-:|--:|\n| 1 | 2 | 3 | 4 |')
    expect(t?.align).toEqual([null, 'left', 'center', 'right'])
    expect(t?.rows).toEqual([['1', '2', '3', '4']])
  })

  it('pads a short row and cuts a long one to the header', () => {
    const t = parseTable('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')
    expect(t?.rows).toEqual([
      ['1', ''],
      ['1', '2']
    ])
  })

  it('is not a table without a delimiter row', () => {
    expect(parseTable('| a | b |\n| 1 | 2 |')).toBeNull()
  })

  it('draws inline markdown, and nothing from the file as markup', () => {
    expect(inlineHtml('**bold** and `x | y` and [link](https://e.x)')).toBe(
      '<strong>bold</strong> and <code>x | y</code> and <span class="cm-md-table-link">link</span>'
    )
    expect(inlineHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
    expect(inlineHtml('`**not bold**`')).toBe('<code>**not bold**</code>')
    expect(inlineHtml('snake_case_name')).toBe('snake_case_name')
  })
})

describe('the markdown file preview', () => {
  afterEach(cleanup)

  it('draws a table as a table', () => {
    const { container } = render(
      <MarkdownPreview value={'# Plan\n\n| Step | Owner |\n|------|-------|\n| Ship | Nyra |\n'} wrap={false} />
    )
    const table = container.querySelector('.cm-md-table table')
    expect(table).not.toBeNull()
    expect([...table!.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Step', 'Owner'])
    expect([...table!.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['Ship', 'Nyra'])
  })
})
