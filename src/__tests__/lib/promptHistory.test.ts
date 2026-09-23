import { describe, expect, it } from 'vitest'
import {
  createPromptHistory,
  endPromptRecall,
  hasRoomToMove,
  recallNewer,
  recallOlder,
  syncPromptHistory
} from '../../renderer/src/lib/promptHistory'

const prompts = ['first prompt', 'second prompt', 'third prompt']

/** Fresh history over these prompts, as a keypress would see it. */
const ready = (): ReturnType<typeof createPromptHistory> =>
  syncPromptHistory(createPromptHistory(), prompts)

describe('walking back through a chat', () => {
  it('starts with nothing to recall', () => {
    const history = createPromptHistory()
    expect(history.cursor).toBe(-1)
    expect(recallOlder(history, 'a draft')).toBeNull()
  })

  it('gives the newest prompt first, and remembers the draft', () => {
    const first = recallOlder(ready(), 'half a thought')!
    expect(first.text).toBe('third prompt')
    expect(first.history.draft).toBe('half a thought')
  })

  it('keeps going older, one press at a time', () => {
    const first = recallOlder(ready(), '')!
    const second = recallOlder(first.history, '')!
    const third = recallOlder(second.history, '')!
    expect([first.text, second.text, third.text]).toEqual([
      'third prompt',
      'second prompt',
      'first prompt'
    ])
  })

  it('stops at the oldest rather than wrapping to the newest', () => {
    const first = recallOlder(ready(), '')!
    const second = recallOlder(first.history, '')!
    const third = recallOlder(second.history, '')!
    expect(recallOlder(third.history, '')).toBeNull()
  })

  // "If I press up only once and then down, the chat would go back to the empty
  // state." The draft is what you had, not what you recalled.
  it('comes back down to the draft, not to the newest prompt', () => {
    const up = recallOlder(ready(), 'half a thought')!
    const down = recallNewer(up.history)!
    expect(down.text).toBe('half a thought')
    expect(down.history.cursor).toBe(-1)
  })

  it('walks forward again once it has come back', () => {
    const up = recallOlder(ready(), '')!
    const back = recallNewer(up.history)!
    const upAgain = recallOlder(back.history, '')!
    expect(upAgain.text).toBe('third prompt')
  })

  it('does nothing on Down while already in the draft', () => {
    // Deleting what you recalled and pressing Down again must not walk forward
    // into the history, which reads as the box having a mind of its own.
    expect(recallNewer(ready())).toBeNull()
  })
})

describe('editing ends the walk', () => {
  it('forgets the cursor, so Up starts from the newest again', () => {
    const first = recallOlder(ready(), '')!
    const second = recallOlder(first.history, '')!
    // `second` is 'second prompt'; editing it means the walk is over.
    const edited = endPromptRecall(second.history)
    expect(edited.cursor).toBe(-1)
    expect(recallOlder(edited, 'my edit')!.text).toBe('third prompt')
  })

  it('leaves an untouched history alone, so nothing re-renders', () => {
    const history = createPromptHistory()
    expect(endPromptRecall(history)).toBe(history)
  })
})

describe('syncPromptHistory', () => {
  it('keeps the walk while the same prompts are in the chat', () => {
    const first = recallOlder(ready(), 'draft')!
    expect(syncPromptHistory(first.history, prompts).cursor).toBe(first.history.cursor)
  })

  it('drops the walk when the chat has moved on', () => {
    const first = recallOlder(ready(), 'draft')!
    const grown = syncPromptHistory(first.history, [...prompts, 'sent while you looked'])
    expect(grown.cursor).toBe(-1)
    expect(grown.draft).toBe('')
  })
})

describe('hasRoomToMove', () => {
  const text = 'first line\nsecond line'

  it('lets Up out of the box from the first line', () => {
    expect(hasRoomToMove(text, 5, 5, 'up')).toBe(false)
  })

  it('leaves Up to the editor from any later line', () => {
    expect(hasRoomToMove(text, 15, 15, 'up')).toBe(true)
  })

  it('lets Down out of the box from the last line', () => {
    expect(hasRoomToMove(text, 15, 15, 'down')).toBe(false)
  })

  it('leaves Down to the editor from the first line', () => {
    expect(hasRoomToMove(text, 5, 5, 'down')).toBe(true)
  })

  it('considers the end of a selection, not its start', () => {
    // Selecting the first line and pressing Down should walk to the second line,
    // not replace the selection with an old prompt.
    expect(hasRoomToMove(text, 0, 10, 'down')).toBe(true)
  })
})
