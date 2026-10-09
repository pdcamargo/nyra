import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_DRAFT, clearDrafts, getDraft, switchDraft, type ComposerDraft } from '@renderer/store/composerDrafts'

const text = (t: string): ComposerDraft => ({ text: t, images: [], files: [] })

describe('composer drafts', () => {
  beforeEach(() => clearDrafts())

  it('keeps each conversation its own draft', () => {
    // Type "Test" in A, go to B: B is empty.
    expect(switchDraft({ id: 'A', empty: false }, { id: 'B', empty: false }, text('Test'))).toEqual(EMPTY_DRAFT)
    // Type "Hello World" in B, go back to A: "Test".
    expect(switchDraft({ id: 'B', empty: false }, { id: 'A', empty: false }, text('Hello World')).text).toBe('Test')
    // And back to B: "Hello World".
    expect(switchDraft({ id: 'A', empty: false }, { id: 'B', empty: false }, text('Test')).text).toBe('Hello World')
  })

  it('does not carry text from a conversation into a new message', () => {
    expect(switchDraft({ id: 'A', empty: false }, { id: 'new', empty: true }, text('Test'))).toEqual(EMPTY_DRAFT)
    expect(getDraft('A')?.text).toBe('Test')
  })

  it('carries an unsent new message into a new message elsewhere', () => {
    // New message, type, then New message in a different project.
    const next = switchDraft({ id: 'new1', empty: true }, { id: 'new2', empty: true }, text('Test'))
    expect(next.text).toBe('Test')
    expect(getDraft('new1')).toBeUndefined()
  })

  it('never overwrites a draft the destination already has', () => {
    switchDraft({ id: 'new2', empty: true }, { id: 'X', empty: false }, text('Mine'))
    const next = switchDraft({ id: 'new1', empty: true }, { id: 'new2', empty: true }, text('Other'))
    expect(next.text).toBe('Mine')
    expect(getDraft('new1')?.text).toBe('Other')
  })

  it('forgets a chat whose box was emptied', () => {
    switchDraft({ id: 'A', empty: false }, { id: 'B', empty: false }, text('Test'))
    switchDraft({ id: 'A', empty: false }, { id: 'B', empty: false }, text('   '))
    expect(getDraft('A')).toBeUndefined()
  })
})
