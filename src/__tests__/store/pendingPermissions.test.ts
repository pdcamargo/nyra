import { beforeEach, describe, expect, it } from 'vitest'
import { usePendingPermissionsStore } from '@renderer/store/pendingPermissions'

describe('pending permissions', () => {
  beforeEach(() => usePendingPermissionsStore.setState({ bySession: {} }))

  it('keeps the first prompt queued for each chat', () => {
    usePendingPermissionsStore.getState().publish([
      { tool_name: 'Bash', nyraSessionId: 'a' },
      { tool_name: 'Edit', nyraSessionId: 'a' },
      { tool_name: 'Write', nyraSessionId: 'b' }
    ])
    expect(usePendingPermissionsStore.getState().bySession).toEqual({ a: 'Bash', b: 'Write' })
  })

  it('leaves out a prompt that belongs to no chat', () => {
    usePendingPermissionsStore.getState().publish([{ tool_name: 'Bash' }])
    expect(usePendingPermissionsStore.getState().bySession).toEqual({})
  })

  it('clears a chat once its queue empties', () => {
    const { publish } = usePendingPermissionsStore.getState()
    publish([{ tool_name: 'Bash', nyraSessionId: 'a' }])
    publish([])
    expect(usePendingPermissionsStore.getState().bySession).toEqual({})
  })
})
