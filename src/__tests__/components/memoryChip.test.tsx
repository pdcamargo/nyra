import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MemoryChip from '../../renderer/src/components/MemoryChip'
import { useUiStore } from '../../renderer/src/store/ui'
import type { MemoryWrite } from '../../renderer/src/lib/memoryWrites'

const MEM = '/Users/x/.claude/projects/-Users-x-repo/memory/a-fact.md'
const INDEX = '/Users/x/.claude/projects/-Users-x-repo/memory/MEMORY.md'

const write = (over: Partial<MemoryWrite> = {}): MemoryWrite => ({
  toolId: 't1',
  filePath: MEM,
  isIndex: false,
  created: false,
  displayName: 'a-fact',
  description: 'Something worth keeping',
  type: 'project',
  status: 'done',
  ...over
})

describe('MemoryChip', () => {
  beforeEach(() => {
    useUiStore.setState({ sidebarTab: 'sessions', pendingMemoryFilePath: null })
  })

  it('names the act and the memory, and nothing else — the tab holds the rest', () => {
    render(<MemoryChip writes={[write()]} />)
    expect(screen.getByText('Project memory updated')).toBeTruthy()
    expect(screen.getByText('a-fact')).toBeTruthy()
    expect(screen.queryByText('Something worth keeping')).toBeNull()
    expect(screen.queryByText('project')).toBeNull()
  })

  it('swallows the index write that accompanies a memory', () => {
    render(
      <MemoryChip
        writes={[
          write(),
          write({ toolId: 't2', isIndex: true, displayName: 'MEMORY', filePath: INDEX })
        ]}
      />
    )
    expect(screen.getByText('Project memory updated')).toBeTruthy()
    expect(screen.queryByText('MEMORY')).toBeNull()
  })

  it('lists several memories after one headline', () => {
    render(<MemoryChip writes={[write(), write({ toolId: 't2', displayName: 'b-fact' })]} />)
    expect(screen.getByText('Project memories updated')).toBeTruthy()
    expect(screen.getByText('a-fact')).toBeTruthy()
    expect(screen.getByText('b-fact')).toBeTruthy()
  })

  it('says an index-only edit once, and opens it from the headline', async () => {
    render(<MemoryChip writes={[write({ isIndex: true, displayName: 'MEMORY', filePath: INDEX })]} />)
    expect(screen.queryByText('MEMORY')).toBeNull()
    await userEvent.click(screen.getByText('Memory index updated'))
    expect(useUiStore.getState().pendingMemoryFilePath).toBe(INDEX)
  })

  it('opens the memory in the sidebar when its name is clicked', async () => {
    render(<MemoryChip writes={[write()]} />)
    await userEvent.click(screen.getByText('a-fact'))
    expect(useUiStore.getState().sidebarTab).toBe('memory')
    expect(useUiStore.getState().pendingMemoryFilePath).toBe(MEM)
  })

  it('says a write failed instead of claiming the memory was kept', () => {
    render(<MemoryChip writes={[write({ status: 'failed' })]} />)
    expect(screen.getByText('Memory could not be saved')).toBeTruthy()
  })
})
