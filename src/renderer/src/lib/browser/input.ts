/**
 * Turning what happened on the canvas into what should happen on the page.
 *
 * All of this is synthetic — there is no real window for Chromium to take input
 * from, so every event the page ever sees is an `Input.dispatch*`, whether it
 * came from the person or from the agent. That is what makes co-driving cheap
 * here: there is nothing to arbitrate, because there is only one kind of input.
 *
 * Dispatches are deliberately not awaited. CDP preserves order per session, so
 * a press and its release cannot cross, and waiting for each round trip would
 * put the whole latency of the socket between a click and its effect.
 */

/** CDP's modifier bitmask. Not the same order as anything else. */
const ALT = 1
const CTRL = 2
const META = 4
const SHIFT = 8

export type Viewport = { width: number; height: number }
export type Point = { x: number; y: number }

export function modifiersOf(event: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): number {
  return (
    (event.altKey ? ALT : 0) |
    (event.ctrlKey ? CTRL : 0) |
    (event.metaKey ? META : 0) |
    (event.shiftKey ? SHIFT : 0)
  )
}

/**
 * Canvas coordinates to page coordinates.
 *
 * One multiply per axis, because the viewport is pinned with
 * `Emulation.setDeviceMetricsOverride` and the canvas is drawn to fill its box.
 * DevTools' own ScreencastView needs four terms here — page scale, a screen
 * offset and the scroll position — because it screencasts a viewport it does not
 * control. Owning the viewport is what buys the simpler version.
 */
export function pageFromCanvas(
  client: Point,
  rect: { left: number; top: number; width: number; height: number },
  viewport: Viewport
): Point {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  const x = ((client.x - rect.left) * viewport.width) / rect.width
  const y = ((client.y - rect.top) * viewport.height) / rect.height
  // A drag that leaves the canvas still reports coordinates; the page should
  // see the edge rather than somewhere that does not exist.
  return {
    x: Math.round(Math.min(Math.max(x, 0), viewport.width)),
    y: Math.round(Math.min(Math.max(y, 0), viewport.height))
  }
}

const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'] as const

export function buttonName(button: number): string {
  return BUTTONS[button] ?? 'left'
}

/** CDP's `buttons` is a mask of what is held, not what changed. */
export function buttonsMask(buttons: number): number {
  return buttons
}

/**
 * A key press, in the shape `Input.dispatchKeyEvent` wants.
 *
 * `text` is what separates a character from a command: send it and the page
 * inserts, omit it and the page only sees the keydown. So printable keys go as
 * `keyDown` with text and everything else as `rawKeyDown`, which is the
 * distinction Chromium itself draws.
 */
export function keyEventOf(
  event: {
    key: string
    code: string
    keyCode: number
    repeat: boolean
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
  },
  type: 'down' | 'up'
): Record<string, unknown> {
  const modifiers = modifiersOf(event)
  // A single character with no command modifier is something to type. With Cmd
  // or Ctrl held it is a shortcut, and inserting "a" for Cmd+A would be wrong.
  const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey
  const text = printable ? event.key : keyTextFor(event.key)

  return {
    type: type === 'up' ? 'keyUp' : printable || text ? 'keyDown' : 'rawKeyDown',
    key: event.key,
    code: event.code,
    // `keyCode` is deprecated in the DOM and is exactly the Windows virtual key
    // code CDP asks for, which is the one place it is still the right answer.
    windowsVirtualKeyCode: event.keyCode,
    nativeVirtualKeyCode: event.keyCode,
    modifiers,
    autoRepeat: event.repeat,
    isKeypad: event.code.startsWith('Numpad'),
    ...(type === 'down' && text ? { text, unmodifiedText: text.toLowerCase() } : {})
  }
}

/** The few named keys that still insert a character. */
function keyTextFor(key: string): string {
  if (key === 'Enter') return '\r'
  if (key === 'Tab') return '\t'
  return ''
}
