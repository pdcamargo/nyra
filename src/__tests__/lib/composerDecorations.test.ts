import { afterEach, describe, expect, it } from 'vitest'
import { isDesignPath } from '@renderer/lib/openFile'
import {
  noteCommandDetails,
  noteCustomCommands,
  noteSkills,
  resetSlashCommands
} from '@renderer/lib/slashCommands'
import {
  commandHintAt,
  findCommand,
  findFileMentions,
  findUltrathink,
  mentionLabel,
  findAttachmentRefs,
  attachmentMarker,
  removeAttachmentRef,
  spanTouched
  } from '../../renderer/src/lib/composerDecorations'

// A skill or a command registered by one test must not style the next one's
// text — `isKnownCommand` reads module state, which outlives the test.
afterEach(() => resetSlashCommands())

describe('findCommand', () => {
  it('matches a known command at the start', () => {
    expect(findCommand('/context please')).toEqual({ from: 0, to: 8 })
  })

  it('ignores a command that is not at the start — the CLI would too', () => {
    expect(findCommand('run /context please')).toBeNull()
  })

  it('leaves an unknown slash alone, because it is probably a path', () => {
    expect(findCommand('/usr/local/bin/claude is where it lives')).toBeNull()
    expect(findCommand('/notacommand')).toBeNull()
  })

  it('matches a hyphenated command', () => {
    expect(findCommand('/pr-review')).toEqual({ from: 0, to: 10 })
  })

  it('stops at the command, not the whole line', () => {
    const span = findCommand('/clear and then some')!
    expect(span.to).toBe('/clear'.length)
  })

  // The screenshot case: a skill on disk with an argument after it. The span has
  // to stop at the name, or the argument gets drawn as part of the command.
  it('styles a skill on disk and stops before its argument', () => {
    noteSkills([{ name: 'claude-api', description: '' }])
    expect(findCommand('/claude-api prompt-audit')).toEqual({
      from: 0,
      to: '/claude-api'.length
    })
  })

  it('matches a namespaced custom command in one span', () => {
    noteCustomCommands([{ name: 'git:sync', description: '' }])
    expect(findCommand('/git:sync now')).toEqual({ from: 0, to: '/git:sync'.length })
  })
})

describe('findUltrathink', () => {
  it('finds it anywhere in the message', () => {
    expect(findUltrathink('please ultrathink this')).toEqual([{ from: 7, to: 17 }])
  })

  it('is case-insensitive', () => {
    expect(findUltrathink('ULTRATHINK')).toHaveLength(1)
  })

  it('finds every occurrence', () => {
    expect(findUltrathink('ultrathink then ultrathink again')).toHaveLength(2)
  })

  it('needs a word boundary, so it does not fire inside another word', () => {
    expect(findUltrathink('superultrathinking')).toEqual([])
  })

  it('returns nothing when absent', () => {
    expect(findUltrathink('just think about it')).toEqual([])
  })
})

describe('findFileMentions', () => {
  it('finds a mention and its span', () => {
    const [m] = findFileMentions('see @src/app.ts here')
    expect(m.path).toBe('src/app.ts')
    expect('see @src/app.ts here'.slice(m.from, m.to)).toBe('@src/app.ts')
  })

  it('finds a mention at the very start', () => {
    expect(findFileMentions('@a/b.ts please')[0].from).toBe(0)
  })

  it('finds several', () => {
    expect(findFileMentions('@a.ts and @b.ts')).toHaveLength(2)
  })

  it('leaves an email alone — the @ has to start a word', () => {
    expect(findFileMentions('mail me at pat@example.com')).toEqual([])
  })

  it('stops at whitespace', () => {
    expect(findFileMentions('@src/app.ts and more')[0].path).toBe('src/app.ts')
  })
})

describe('mentionLabel', () => {
  it('shows just the filename', () => {
    expect(mentionLabel('src/renderer/components/ChatInput.tsx')).toBe('ChatInput.tsx')
  })

  it('shows a bare name unchanged', () => {
    expect(mentionLabel('README.md')).toBe('README.md')
  })

  it('names a folder by its last segment, trailing slash and all', () => {
    expect(mentionLabel('src/renderer/components/')).toBe('components')
  })
})

describe('attachment references', () => {
  it('finds an image reference and names it by file', () => {
    const [ref] = findAttachmentRefs('look at [Image: /tmp/nyra/shot-2.png] here')
    expect(ref).toMatchObject({ kind: 'Image', target: '/tmp/nyra/shot-2.png' })
    expect(mentionLabel(ref.target)).toBe('shot-2.png')
  })

  it('finds a file reference by name', () => {
    const [ref] = findAttachmentRefs('as [File: quarterly report.pdf] says')
    expect(ref).toMatchObject({ kind: 'File', target: 'quarterly report.pdf' })
  })

  it('finds several in one sentence, in order', () => {
    const refs = findAttachmentRefs('[Image: /a.png] versus [Image: /b.png]')
    expect(refs.map((r) => r.target)).toEqual(['/a.png', '/b.png'])
  })

  it('leaves ordinary bracketed text alone', () => {
    expect(findAttachmentRefs('[note: this is not an attachment]')).toEqual([])
    expect(findAttachmentRefs('a markdown [link](http://x)')).toEqual([])
  })

  it('does not run past the end of a line', () => {
    // An unclosed bracket should not swallow the rest of the message.
    expect(findAttachmentRefs('[Image: /a.png\nsecond line]')).toEqual([])
  })

  it('spans exactly the marker, so replacing it removes the whole thing', () => {
    const text = 'before [Image: /a.png] after'
    const [ref] = findAttachmentRefs(text)
    expect(text.slice(ref.from, ref.to)).toBe('[Image: /a.png]')
  })

  it('round-trips what attachmentMarker writes', () => {
    const marker = attachmentMarker('Image', '/tmp/a b.png')
    const [ref] = findAttachmentRefs(`x ${marker} y`)
    expect(ref.target).toBe('/tmp/a b.png')
  })
})

describe('spanTouched', () => {
  const span = { from: 10, to: 20 }
  const at = (n: number): { from: number; to: number }[] => [{ from: n, to: n }]

  it('is false for a caret away from the span', () => {
    expect(spanTouched(span, at(5))).toBe(false)
    expect(spanTouched(span, at(25))).toBe(false)
  })

  it('is true for a caret inside it', () => {
    expect(spanTouched(span, at(15))).toBe(true)
  })

  // Load-bearing for @-mentions: while you type `@src/comp` the caret sits at
  // the end of the span, and collapsing it to a chip there would eat the word.
  it('is true at either edge', () => {
    expect(spanTouched(span, at(10))).toBe(true)
    expect(spanTouched(span, at(20))).toBe(true)
  })

  it('is true for a selection that covers or overlaps it', () => {
    expect(spanTouched(span, [{ from: 0, to: 30 }])).toBe(true)
    expect(spanTouched(span, [{ from: 18, to: 40 }])).toBe(true)
  })

  it('checks every range of a multi-cursor selection', () => {
    expect(spanTouched(span, [{ from: 0, to: 1 }, { from: 14, to: 14 }])).toBe(true)
    expect(spanTouched(span, [{ from: 0, to: 1 }, { from: 30, to: 31 }])).toBe(false)
  })

  // The old rule was line granularity, which is why a pasted attachment showed
  // as raw markdown until you broke the line.
  it('leaves the rest of the line alone', () => {
    const text = 'see [Image: /tmp/a.png] here'
    const ref = findAttachmentRefs(text)[0]
    expect(spanTouched(ref, at(text.length))).toBe(false)
  })
})

describe('removeAttachmentRef', () => {
  it('takes the marker out and closes the gap', () => {
    expect(removeAttachmentRef('look at [Image: /tmp/a.png] here', 'Image', '/tmp/a.png')).toBe(
      'look at here'
    )
  })

  it('does not leave a trailing space at the end of the draft', () => {
    expect(removeAttachmentRef('look at [Image: /tmp/a.png]', 'Image', '/tmp/a.png')).toBe('look at')
  })

  it('handles a file marker and one that is the whole draft', () => {
    expect(removeAttachmentRef('[File: notes.pdf]', 'File', 'notes.pdf')).toBe('')
  })

  it('leaves the draft alone when the marker is not there', () => {
    expect(removeAttachmentRef('nothing here', 'Image', '/tmp/a.png')).toBe('nothing here')
  })

  it('removes only the one asked for', () => {
    const text = '[Image: /tmp/a.png] and [Image: /tmp/b.png]'
    expect(removeAttachmentRef(text, 'Image', '/tmp/a.png')).toBe('and [Image: /tmp/b.png]')
  })
})

describe('a design mention is a design chip', () => {
  /**
   * The third renderer, and the one that got missed twice.
   *
   * A design reference is drawn in three genuinely separate places — the
   * composer decorates live text, `promptMarkdown` decorates a sent message,
   * and `MarkdownRenderer` decorates Claude's reply. Referencing a design from
   * the canvas chipped it blue here, with a filename and a dangling `#general`,
   * right next to the pink chip Claude posts for the same design.
   */
  it('recognises one among ordinary mentions', () => {
    const text = 'compare @/a/src/App.tsx with @/a/b.nyui.json#general please'
    const mentions = findFileMentions(text)
    expect(mentions.map((m) => m.path)).toEqual(['/a/src/App.tsx', '/a/b.nyui.json#general'])
    expect(isDesignPath(mentions[0].path)).toBe(false)
    expect(isDesignPath(mentions[1].path)).toBe(true)
  })

  it('keeps the fragment inside the mention rather than ending at the extension', () => {
    // If the span stopped at `.json`, the `#general` would be left as loose
    // text beside the chip — which is what it looked like before.
    const [mention] = findFileMentions('@/a/b.nyui.json#settings-protocol')
    expect(mention.path).toBe('/a/b.nyui.json#settings-protocol')
    expect(mention.to - mention.from).toBe('@/a/b.nyui.json#settings-protocol'.length)
  })
})

describe('commandHintAt', () => {
  afterEach(() => resetSlashCommands())

  it('shows what a command takes while nothing has been typed after it', () => {
    noteCommandDetails([{ name: 'model', argumentHint: '<model>' }])
    expect(commandHintAt('/model', 6)).toEqual({ at: 6, hint: '<model>' })
    expect(commandHintAt('/model ', 7)).toEqual({ at: 7, hint: '<model>' })
  })

  it('goes once the argument is started, or the caret is elsewhere', () => {
    noteCommandDetails([{ name: 'model', argumentHint: '<model>' }])
    expect(commandHintAt('/model op', 9)).toBeNull()
    expect(commandHintAt('/model', 3)).toBeNull()
  })

  it('says nothing for a command that declares no argument', () => {
    noteCommandDetails([{ name: 'model', argumentHint: '<model>' }])
    expect(commandHintAt('/clear', 6)).toBeNull()
  })
})
