import { beforeEach, describe, expect, it } from 'vitest'
import { handleAppRequest } from '@renderer/lib/appControl'
import { answerDesktopAccess, forgetAlways } from '@renderer/lib/desktopControl'
import { useDesktopStore } from '@renderer/store/desktop'
import { useSettingsStore } from '@renderer/store/settings'

const ask = (chatId: string, id = 'com.apple.mail', name = 'Mail') =>
  handleAppRequest('desktop.allow', { chatId, app: { id, name }, warning: null }) as Promise<{
    answer: string
  }>

const pending = (chatId: string) => useDesktopStore.getState().bySession[chatId]?.asks ?? []

beforeEach(() => {
  useDesktopStore.setState({ bySession: {} })
  useSettingsStore.getState().updateSettings({ desktopAllowedApps: [], desktopAppNames: {} })
})

/**
 * Rust asks whether a chat may use an app and waits. What comes back is the
 * user's press, and "always" is the one answer that has to outlive the turn —
 * so it is written here, to the settings Rust reads.
 */
describe('the desktop allow question', () => {
  it('waits in the chat that asked, and answers with the press', async () => {
    const answered = ask('chat-a')
    expect(pending('chat-a')).toHaveLength(1)
    expect(pending('chat-b')).toHaveLength(0)

    answerDesktopAccess('chat-a', pending('chat-a')[0].key, 'chat')
    await expect(answered).resolves.toEqual({ answer: 'chat' })
    expect(pending('chat-a')).toHaveLength(0)
    // "In this chat" is not remembered anywhere Rust reads across chats.
    expect(useSettingsStore.getState().desktopAllowedApps).toEqual([])
  })

  it('writes "always" to settings, with a name to show for it', async () => {
    const answered = ask('chat-a')
    answerDesktopAccess('chat-a', pending('chat-a')[0].key, 'always')
    await answered
    const s = useSettingsStore.getState()
    expect(s.desktopAllowedApps).toEqual(['com.apple.mail'])
    expect(s.desktopAppNames['com.apple.mail']).toBe('Mail')

    forgetAlways('com.apple.mail')
    expect(useSettingsStore.getState().desktopAllowedApps).toEqual([])
  })

  it('takes one question at a time, and a second answer is a no-op', async () => {
    const first = ask('chat-a')
    const second = ask('chat-a', 'com.apple.Notes', 'Notes')
    const [a, b] = pending('chat-a')
    expect(a.app.name).toBe('Mail')
    answerDesktopAccess('chat-a', a.key, 'no')
    answerDesktopAccess('chat-a', a.key, 'always')
    await expect(first).resolves.toEqual({ answer: 'no' })
    expect(useSettingsStore.getState().desktopAllowedApps).toEqual([])

    answerDesktopAccess('chat-a', b.key, 'chat')
    await expect(second).resolves.toEqual({ answer: 'chat' })
  })

  it('refuses a question that names no chat or app', async () => {
    await expect(handleAppRequest('desktop.allow', { app: { id: 'x' } })).rejects.toThrow()
  })
})
