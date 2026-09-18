import { describe, expect, it } from 'vitest'
import { resolveChatSettings } from '@renderer/hooks/useChatSettings'

const defaults = { planMode: false, model: '', effort: '' } as const

describe('resolveChatSettings', () => {
  it('falls back to the defaults for a chat that has never set anything', () => {
    expect(resolveChatSettings(undefined, defaults)).toEqual({
      planMode: false,
      model: '',
      effort: ''
    })
    expect(resolveChatSettings({}, { ...defaults, planMode: true }).planMode).toBe(true)
  })

  it('lets a chat override each setting on its own', () => {
    expect(resolveChatSettings({ planMode: true }, defaults).planMode).toBe(true)
    expect(resolveChatSettings({ model: 'haiku' }, defaults).model).toBe('haiku')
    expect(resolveChatSettings({ effort: 'low' }, defaults).effort).toBe('low')
  })

  // The bug this exists for: plan mode was global, so turning it on in one chat
  // turned it on in every other one — including chats mid-turn.
  it('keeps one chat turning plan mode off while the default stays on', () => {
    const on = { ...defaults, planMode: true }
    expect(resolveChatSettings({ planMode: false }, on).planMode).toBe(false)
    expect(resolveChatSettings(undefined, on).planMode).toBe(true)
  })

  it('treats an explicit empty model as an override, not as unset', () => {
    // '' means "CLI default" and is a real choice; only undefined defers.
    expect(resolveChatSettings({ model: '' }, { ...defaults, model: 'opus' }).model).toBe('')
    expect(resolveChatSettings({}, { ...defaults, model: 'opus' }).model).toBe('opus')
  })
})
