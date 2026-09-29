/**
 * The renderer's half of desktop control.
 *
 * Rust asks one question — may this chat use this app — and waits up to two
 * minutes for the answer. This puts the question in that chat's composer and
 * answers with whatever is pressed. "Always" is written to settings here,
 * because settings are the renderer's to write; Rust reads the list back.
 *
 * Everything else is Rust telling us things: what a chat is controlling, what
 * permission it found missing, and that Esc stopped it.
 */
import { useDesktopStore, type DesktopAnswer } from '../store/desktop'
import { useSettingsStore } from '../store/settings'

/** Rust gives up at 120s; drop the question just before, so it never outlives it. */
const ASK_LIFETIME_MS = 118_000

let counter = 0

export function askDesktopAccess(args: Record<string, unknown>): Promise<{ answer: string }> {
  const chatId = typeof args.chatId === 'string' ? args.chatId : ''
  const app = args.app as { id?: unknown; name?: unknown } | undefined
  const id = typeof app?.id === 'string' ? app.id : ''
  const name = typeof app?.name === 'string' ? app.name : id
  if (!chatId || !id) return Promise.reject(new Error('desktop.allow needs a chatId and an app'))

  const key = `ask-${++counter}`
  return new Promise((resolve) => {
    const timer = window.setTimeout(
      () => useDesktopStore.getState().settleAsk(chatId, key, 'dismissed'),
      ASK_LIFETIME_MS
    )
    useDesktopStore.getState().pushAsk(chatId, {
      key,
      app: { id, name },
      warning: typeof args.warning === 'string' ? args.warning : null,
      resolve: (answer) => {
        window.clearTimeout(timer)
        if (answer === 'always') rememberAlways(id, name)
        resolve({ answer })
      }
    })
  })
}

export function answerDesktopAccess(chatId: string, key: string, answer: DesktopAnswer): void {
  useDesktopStore.getState().settleAsk(chatId, key, answer)
}

function rememberAlways(id: string, name: string): void {
  const s = useSettingsStore.getState()
  if (s.desktopAllowedApps.includes(id)) return
  s.updateSettings({
    desktopAllowedApps: [...s.desktopAllowedApps, id],
    desktopAppNames: { ...s.desktopAppNames, [id]: name }
  })
}

export function forgetAlways(id: string): void {
  const s = useSettingsStore.getState()
  const names = { ...s.desktopAppNames }
  delete names[id]
  s.updateSettings({
    desktopAllowedApps: s.desktopAllowedApps.filter((a) => a !== id),
    desktopAppNames: names
  })
}

/** Subscribed once, for the life of the app: the events can arrive whatever is mounted. */
export function startDesktopEvents(): () => void {
  const store = useDesktopStore.getState
  const stops = [
    window.api.desktop.onActivity(({ chatId, app }) => store().setControlling(chatId, app)),
    window.api.desktop.onBlocked(({ chatId, kind, reason, fix }) =>
      store().setBlocked(chatId, { kind, reason, fix })
    ),
    window.api.desktop.onStopped(({ chats }) => {
      for (const chatId of chats) store().setControlling(chatId, null)
    })
  ]
  return () => stops.forEach((stop) => stop())
}
