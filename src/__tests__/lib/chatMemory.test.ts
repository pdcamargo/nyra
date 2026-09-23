import { describe, expect, it, vi } from 'vitest'
import { formatMemory, readChatMemory } from '../../renderer/src/lib/chatMemory'

describe('formatMemory', () => {
  it('picks the unit a person reads the number in', () => {
    expect(formatMemory(0)).toBe('0 B')
    expect(formatMemory(900)).toBe('900 B')
    expect(formatMemory(64 * 1024)).toBe('64 KB')
    expect(formatMemory(1.5 * 1024 * 1024)).toBe('1.5 MB')
    // A megabyte is not a useful grain once there are hundreds of them.
    expect(formatMemory(412.4 * 1024 * 1024)).toBe('412 MB')
    expect(formatMemory(1.2 * 1024 ** 3)).toBe('1.2 GB')
  })
})

describe('readChatMemory', () => {
  it('answers what the backend measured', async () => {
    const memory = vi
      .spyOn(window.api.processes, 'memory')
      .mockResolvedValue({ bytes: 1024, processes: 3 })
    expect(await readChatMemory('chat-1')).toEqual({ bytes: 1024, processes: 3 })
    expect(memory).toHaveBeenCalledWith('chat-1')
    vi.restoreAllMocks()
  })

  it('is a dash, not a throw, when the backend cannot answer', async () => {
    vi.spyOn(window.api.processes, 'memory').mockRejectedValue(new Error('no such session'))
    expect(await readChatMemory('chat-1')).toBeNull()
    vi.restoreAllMocks()
  })
})
