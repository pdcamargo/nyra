/**
 * A Chrome DevTools Protocol connection, held by the renderer itself.
 *
 * The sidecar launches Chromium and owns the contexts, but it is not in the
 * frame path: pixels would otherwise cross a pipe into Rust, through the IPC
 * bridge, and into the webview, three copies to show one screenshot. Instead the
 * webview opens its own socket to the browser-level endpoint and runs its own
 * flat sessions. Chromium supports several clients per target — measured, with
 * Playwright driving the same pages at the same time.
 *
 * Two things make this possible and are easy to lose:
 *  - Chromium answers a WebSocket with a disallowed `Origin` with a 403, so the
 *    sidecar launches it with `--remote-allow-origins` naming the Tauri origin.
 *  - The URL must be addressed as `localhost`, not `127.0.0.1`, because that is
 *    what the CSP allows. The sidecar reads it back from the DevTools endpoint
 *    rather than building it, which keeps that true.
 */

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type CdpEventHandler = (params: Record<string, unknown>, sessionId?: string) => void

export type CdpConnection = {
  readonly url: string
  send: <T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ) => Promise<T>
  /** Fires for every session unless the handler filters on the sessionId. */
  on: (method: string, handler: CdpEventHandler) => () => void
  attach: (targetId: string) => Promise<string>
  detach: (sessionId: string) => Promise<void>
  close: () => void
  readonly closed: boolean
}

/** Long enough for a busy renderer, short enough to surface a wedged target. */
const CALL_TIMEOUT_MS = 15_000

export function connectCdp(url: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map<number, Pending>()
    const handlers = new Map<string, Set<CdpEventHandler>>()
    let nextId = 0
    let closed = false

    const failAll = (reason: string): void => {
      const outstanding = [...pending.values()]
      pending.clear()
      for (const p of outstanding) p.reject(new Error(reason))
    }

    socket.addEventListener('message', (event) => {
      let message: {
        id?: number
        method?: string
        params?: Record<string, unknown>
        sessionId?: string
        result?: unknown
        error?: { message: string }
      }
      try {
        message = JSON.parse(event.data as string)
      } catch {
        return
      }

      if (message.id !== undefined) {
        const waiting = pending.get(message.id)
        if (!waiting) return
        pending.delete(message.id)
        if (message.error) waiting.reject(new Error(message.error.message))
        else waiting.resolve(message.result)
        return
      }

      if (!message.method) return
      for (const handler of handlers.get(message.method) ?? []) {
        try {
          handler(message.params ?? {}, message.sessionId)
        } catch (err) {
          console.error(`[cdp] ${message.method} handler failed`, err)
        }
      }
    })

    socket.addEventListener('error', () => {
      if (!closed) reject(new Error(`Could not open a CDP socket to ${url}`))
    })

    socket.addEventListener('close', () => {
      closed = true
      failAll('The CDP connection closed.')
    })

    const send = <T,>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string
    ): Promise<T> => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('The CDP connection is not open.'))
      }
      const id = ++nextId
      socket.send(JSON.stringify({ id, method, params, sessionId }))
      return new Promise<T>((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rej(new Error(`${method} timed out`))
        }, CALL_TIMEOUT_MS)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            res(value as T)
          },
          reject: (error) => {
            clearTimeout(timer)
            rej(error)
          }
        })
      })
    }

    socket.addEventListener(
      'open',
      () => {
        resolve({
          url,
          send,
          on: (method, handler) => {
            const set = handlers.get(method) ?? new Set()
            handlers.set(method, set)
            set.add(handler)
            return () => {
              set.delete(handler)
            }
          },
          // `flatten` puts every session on this one socket, which is what lets
          // one connection carry a screencast per tab.
          attach: async (targetId) => {
            const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', {
              targetId,
              flatten: true
            })
            return sessionId
          },
          detach: async (sessionId) => {
            await send('Target.detachFromTarget', { sessionId }).catch(() => {})
          },
          close: () => {
            closed = true
            failAll('The CDP connection was closed.')
            socket.close()
          },
          get closed() {
            return closed
          }
        })
      },
      { once: true }
    )
  })
}
