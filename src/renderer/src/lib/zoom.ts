import { getCurrentWebview } from '@tauri-apps/api/webview'
import { DEFAULT_SETTINGS } from '../../../shared/types'

/**
 * Webview zoom, not CSS zoom.
 *
 * The app carries 400-odd hardcoded `text-[Npx]` classes, so scaling the root
 * font size would move the spacing and leave most of the type where it was.
 * Webview zoom scales the CSS pixel itself, which means every layout formula —
 * including the `100vw` term the chat column centres on — stays exactly correct.
 */
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

export const MIN_ZOOM = ZOOM_STEPS[0]
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]

/** The zustand persist key for the settings store. Renaming it drops user data. */
const SETTINGS_KEY = 'nyra-settings'

/**
 * The next step up or down the ladder.
 *
 * A value that is not on the ladder — hand-edited storage, or a ladder that
 * changed between releases — snaps to the neighbouring step in the direction
 * asked for rather than jumping to an end.
 */
export function nextZoom(current: number, direction: 1 | -1): number {
  const steps = ZOOM_STEPS as readonly number[]
  if (direction === 1) return steps.find((s) => s > current + 1e-6) ?? MAX_ZOOM
  return [...steps].reverse().find((s) => s < current - 1e-6) ?? MIN_ZOOM
}

export function clampZoom(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SETTINGS.zoom
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n))
}

/**
 * Read the persisted factor without pulling in the store.
 *
 * main.tsx applies zoom before React mounts, for the same reason it applies the
 * theme there: the first paint should be at the size you left it, not at 100%.
 */
export function persistedZoom(): number {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS.zoom
    const parsed = JSON.parse(raw) as { state?: { zoom?: unknown }; zoom?: unknown }
    return clampZoom(parsed?.state?.zoom ?? parsed?.zoom)
  } catch {
    // Unparseable or unavailable storage is not worth failing a boot over.
    return DEFAULT_SETTINGS.zoom
  }
}

/**
 * Ask the webview to scale.
 *
 * Swallows failure on purpose: the capability could be missing, and on macOS
 * this maps to WKWebView's `pageZoom`. Neither is worth a blank window.
 */
export async function applyZoom(factor: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(clampZoom(factor))
  } catch {
    // Left at whatever the webview was already doing.
  }
}
