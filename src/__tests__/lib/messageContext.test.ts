import { beforeEach, describe, expect, it } from 'vitest'
import { pendingContext, takePendingContext, withContext } from '../../renderer/src/lib/messageContext'
import { useAnnotationsStore } from '../../renderer/src/store/annotations'
import type { ChatAnnotation } from '../../renderer/src/lib/chatAnnotations'

const note = (partial: Partial<ChatAnnotation> = {}): ChatAnnotation => ({
  id: 'n1',
  messageId: 'm1',
  source: 'assistant',
  start: 0,
  end: 9,
  quote: 'Interleave',
  comment: 'only if relevance is cheap',
  order: 1,
  ...partial
})

describe('pending context', () => {
  beforeEach(() => useAnnotationsStore.setState({ bySession: {}, editing: null }))

  it('is nothing when nothing is waiting', () => {
    expect(pendingContext('s1')).toBeUndefined()
    expect(takePendingContext('s1')).toBeUndefined()
  })

  it('looks without taking, so a send that fails leaves the tray as it was', () => {
    useAnnotationsStore.getState().add('s1', note())
    const context = pendingContext('s1')
    expect(context?.map((c) => c.kind)).toEqual(['chat-annotation'])
    expect(useAnnotationsStore.getState().bySession.s1).toHaveLength(1)
  })

  it('hands annotations over with an answer and empties the tray', () => {
    useAnnotationsStore.getState().add('s1', note())
    const context = takePendingContext('s1')
    expect(withContext('Concatenate A then B', context)).toContain('only if relevance is cheap')
    expect(useAnnotationsStore.getState().bySession.s1).toBeUndefined()
  })

  it('takes only the chat it is asked for', () => {
    useAnnotationsStore.getState().add('s1', note())
    useAnnotationsStore.getState().add('s2', note({ id: 'n2' }))
    takePendingContext('s1')
    expect(useAnnotationsStore.getState().bySession.s2).toHaveLength(1)
  })
})
