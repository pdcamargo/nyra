import { beforeEach, describe, expect, it } from 'vitest'
import { useResourceDockStore } from '../../renderer/src/store/resourceDock'

beforeEach(() => {
  useResourceDockStore.setState({ bySession: {} })
})

describe('resource dock', () => {
  it('keeps each chat independent and replaces its open resource', () => {
    const dock = useResourceDockStore.getState()
    dock.open('chat-a', 'mcp')
    dock.open('chat-b', 'status')
    dock.open('chat-a', 'status')

    expect(useResourceDockStore.getState().bySession).toEqual({
      'chat-a': 'status',
      'chat-b': 'status'
    })
  })

  it('closes without losing another chat and forgets a deleted chat', () => {
    const dock = useResourceDockStore.getState()
    dock.open('chat-a', 'mcp')
    dock.open('chat-b', 'status')
    dock.close('chat-a')

    expect(useResourceDockStore.getState().bySession['chat-a']).toBeUndefined()
    expect(useResourceDockStore.getState().bySession['chat-b']).toBe('status')

    dock.forget('chat-a')
    expect(useResourceDockStore.getState().bySession).toEqual({ 'chat-b': 'status' })
  })
})
