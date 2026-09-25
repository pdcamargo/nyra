import { describe, it, expect } from 'vitest'
import {
  isMemoryPeek,
  isMemoryWrite,
  memoryDeletedPaths,
  memoryWritesFrom,
  memoryFilePath,
  memoryWriteFrom,
  parseMemoryFrontmatter,
  resultingContent,
  summarizeMemoryWrites,
  type MemoryWrite
} from '../../renderer/src/lib/memoryWrites'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

const MEM = '/Users/x/.claude/projects/-Users-x-repo/memory/a-fact.md'

const call = (over: Partial<ToolCallMessage> = {}): ToolCallMessage => ({
  id: 'm1',
  role: 'tool_call',
  tool_id: 't1',
  tool_name: 'Write',
  input: { file_path: MEM, content: '# a fact' },
  ...over
})

const frontmatter = [
  '---',
  'name: a-fact',
  'description: "Something worth keeping, with a comma"',
  'metadata:',
  '  node_type: memory',
  '  type: project',
  '---',
  '',
  'The body.'
].join('\n')

describe('memoryFilePath', () => {
  it('claims a write under the per-project memory directory', () => {
    expect(memoryFilePath('Write', { file_path: MEM })).toBe(MEM)
    expect(memoryFilePath('Edit', { file_path: MEM })).toBe(MEM)
  })

  it('leaves the rest of .claude alone — those are the user’s own setup', () => {
    expect(memoryFilePath('Write', { file_path: '/Users/x/.claude/agents/foo.md' })).toBeNull()
    expect(memoryFilePath('Write', { file_path: '/Users/x/.claude/settings.json' })).toBeNull()
    expect(memoryFilePath('Write', { file_path: '/repo/CLAUDE.md' })).toBeNull()
    // A project directory that merely mentions memory is not memory.
    expect(memoryFilePath('Write', { file_path: '/repo/src/memory/store.ts' })).toBeNull()
  })

  it('is about writing, not reading — recall leaves no tool call to show', () => {
    expect(memoryFilePath('Read', { file_path: MEM })).toBeNull()
  })
})

describe('isMemoryWrite', () => {
  it('sends a denied write back to the ordinary tool line — it recorded nothing', () => {
    expect(isMemoryWrite(call())).toBe(true)
    expect(isMemoryWrite(call({ denied: true }))).toBe(false)
  })
})

describe('parseMemoryFrontmatter', () => {
  it('finds the type nested under metadata, and unquotes the description', () => {
    const front = parseMemoryFrontmatter(frontmatter)
    expect(front.name).toBe('a-fact')
    expect(front.description).toBe('Something worth keeping, with a comma')
    expect(front.type).toBe('project')
  })

  it('does not mistake node_type for type', () => {
    expect(parseMemoryFrontmatter('---\nmetadata:\n  node_type: memory\n---\n').type).toBeUndefined()
  })

  it('ignores a type it does not know', () => {
    expect(parseMemoryFrontmatter('---\ntype: nonsense\n---\n').type).toBeUndefined()
  })

  it('shrugs at a file with no frontmatter', () => {
    expect(parseMemoryFrontmatter('# Just a heading\n')).toEqual({})
  })
})

describe('resultingContent', () => {
  it('replays an edit onto the file so a body-only edit still yields frontmatter', () => {
    const msg = call({
      tool_name: 'Edit',
      input: { file_path: MEM, old_string: 'The body.', new_string: 'A longer body.' },
      originalContent: frontmatter
    })
    expect(parseMemoryFrontmatter(resultingContent(msg)).name).toBe('a-fact')
    expect(resultingContent(msg)).toContain('A longer body.')
  })

  it('treats a replacement as text, not as regex backreferences', () => {
    const msg = call({
      tool_name: 'Edit',
      input: { file_path: MEM, old_string: 'x', new_string: '$& and $1' },
      originalContent: 'x'
    })
    expect(resultingContent(msg)).toBe('$& and $1')
  })

  it('falls back to the fragment when the file was never captured', () => {
    const msg = call({
      tool_name: 'Edit',
      input: { file_path: MEM, old_string: 'a', new_string: 'b' },
      originalContent: null
    })
    expect(resultingContent(msg)).toBe('b')
  })
})

describe('memoryWriteFrom', () => {
  it('describes a new memory from the content it is being given', () => {
    const w = memoryWriteFrom(call({ input: { file_path: MEM, content: frontmatter }, originalContent: null }))!
    expect(w.displayName).toBe('a-fact')
    expect(w.description).toBe('Something worth keeping, with a comma')
    expect(w.type).toBe('project')
    expect(w.created).toBe(true)
    expect(w.isIndex).toBe(false)
    expect(w.status).toBe('pending')
  })

  it('reads an overwrite of an existing memory as an update', () => {
    const w = memoryWriteFrom(call({ originalContent: 'was here', result: '' }))!
    expect(w.created).toBe(false)
    expect(w.status).toBe('done')
  })

  it('marks the index as the index and names it from the file', () => {
    const path = '/Users/x/.claude/projects/-Users-x-repo/memory/MEMORY.md'
    const w = memoryWriteFrom(call({ tool_name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }))!
    expect(w.isIndex).toBe(true)
    expect(w.displayName).toBe('MEMORY')
  })

  it('reports a failed write rather than claiming the memory was kept', () => {
    const w = memoryWriteFrom(call({ result: 'Error: EACCES: permission denied' }))!
    expect(w.status).toBe('failed')
  })
})

describe('summarizeMemoryWrites', () => {
  const write = (over: Partial<MemoryWrite> = {}): MemoryWrite => ({
    toolId: 't',
    filePath: MEM,
    isIndex: false,
    created: false,
    deleted: false,
    displayName: 'a-fact',
    status: 'done',
    ...over
  })

  it('counts the memory, not the index line that accompanies it', () => {
    expect(summarizeMemoryWrites([write(), write({ toolId: 'u', isIndex: true })])).toBe(
      'Project memory updated'
    )
  })

  it('distinguishes a memory being kept for the first time', () => {
    expect(summarizeMemoryWrites([write({ created: true })])).toBe('Project memory saved')
  })

  it('leaves the count to the names when there is more than one', () => {
    expect(summarizeMemoryWrites([write(), write({ toolId: 'u' })])).toBe(
      'Project memories updated'
    )
  })

  it('says so while it is still being written, and when it failed', () => {
    expect(summarizeMemoryWrites([write({ status: 'pending' })])).toBe('Saving to memory…')
    expect(summarizeMemoryWrites([write({ status: 'failed' })])).toBe('Memory could not be saved')
  })

  it('names an index-only edit for what it is', () => {
    expect(summarizeMemoryWrites([write({ isIndex: true })])).toBe('Memory index updated')
  })
})

describe('isMemoryPeek', () => {
  const INDEX = '/Users/x/.claude/projects/-Users-x-repo/memory/MEMORY.md'

  it('recognises a cat of the index and a Read of a memory', () => {
    expect(isMemoryPeek(call({ tool_name: 'Bash', input: { command: `cat ${INDEX}` } }))).toBe(true)
    expect(isMemoryPeek(call({ tool_name: 'Read', input: { file_path: MEM } }))).toBe(true)
  })

  it('leaves writes to isMemoryWrite, and ignores the rest of .claude', () => {
    expect(isMemoryPeek(call())).toBe(false)
    expect(isMemoryPeek(call({ tool_name: 'Read', input: { file_path: '/Users/x/.claude/settings.json' } }))).toBe(false)
    expect(isMemoryPeek(call({ tool_name: 'Bash', input: { command: 'ls' } }))).toBe(false)
  })

  it('does not swallow a denied call', () => {
    expect(isMemoryPeek(call({ tool_name: 'Read', input: { file_path: MEM }, denied: true }))).toBe(false)
  })
})

describe('memory deletes', () => {
  const B = '/Users/x/.claude/projects/-Users-x-repo/memory/b-fact.md'
  const rm = (command: string, over: Partial<ToolCallMessage> = {}): ToolCallMessage =>
    call({ tool_name: 'Bash', input: { command }, ...over })

  it('reads every memory an rm removes, flags and quotes aside', () => {
    expect(memoryDeletedPaths('Bash', { command: `rm -f "${MEM}" ${B}` })).toEqual([MEM, B])
    expect(memoryDeletedPaths('Bash', { command: `cd /tmp && rm ${MEM}` })).toEqual([MEM])
  })

  it('ignores rm of anything that is not a memory, and non-rm commands', () => {
    expect(memoryDeletedPaths('Bash', { command: 'rm /tmp/scratch.md' })).toEqual([])
    expect(memoryDeletedPaths('Bash', { command: `cat ${MEM}` })).toEqual([])
    expect(isMemoryWrite(rm(`cat ${MEM}`))).toBe(false)
  })

  it('turns an rm into a deleted memory with its own headline', () => {
    const writes = memoryWritesFrom(rm(`rm ${MEM}`, { result: '' }))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ deleted: true, displayName: 'a-fact', status: 'done' })
    expect(summarizeMemoryWrites(writes)).toBe('Project memory deleted')
    expect(summarizeMemoryWrites(memoryWritesFrom(rm(`rm ${MEM} ${B}`, { result: '' })))).toBe(
      'Project memories deleted'
    )
  })

  it('says it is deleting while the rm runs', () => {
    expect(summarizeMemoryWrites(memoryWritesFrom(rm(`rm ${MEM}`)))).toBe('Deleting from memory…')
  })
})
