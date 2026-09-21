// The sizes a page can be rendered at, and the one place they are written down.
//
// The renderer cannot import this file — `tsconfig.web.json` covers only the
// renderer, `src/shared` and the tests, with no `allowJs` — so the list travels
// to the UI inside `status()` instead. That is deliberate rather than a
// workaround: it means the menu and the agent's tool enum are built from the
// same array and cannot drift apart.
//
// `deviceScaleFactor: null` means "whatever the person's own screen is". A
// desktop preset on a Retina machine should render the way their real browser
// would; only the phones and tablets carry a pixel ratio of their own, because
// that is a fact about the device rather than about the viewer.

/** CSS pixels. Below the floor a page stops being a page; above the ceiling
 *  Chromium starts refusing to allocate the raster. */
export const MIN_DIMENSION = 200
export const MAX_DIMENSION = 4000

export const DEVICES = [
  { id: 'desktop', label: 'Desktop', width: 1280, height: 800, deviceScaleFactor: null, mobile: false, hasTouch: false },
  { id: 'laptop', label: 'Laptop', width: 1440, height: 900, deviceScaleFactor: null, mobile: false, hasTouch: false },
  { id: 'ipad-pro', label: 'iPad Pro 11"', width: 834, height: 1194, deviceScaleFactor: 2, mobile: true, hasTouch: true },
  { id: 'ipad-mini', label: 'iPad mini', width: 744, height: 1133, deviceScaleFactor: 2, mobile: true, hasTouch: true },
  { id: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max', width: 440, height: 956, deviceScaleFactor: 3, mobile: true, hasTouch: true },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro', width: 402, height: 874, deviceScaleFactor: 3, mobile: true, hasTouch: true },
  { id: 'iphone-16', label: 'iPhone 16', width: 393, height: 852, deviceScaleFactor: 3, mobile: true, hasTouch: true },
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, deviceScaleFactor: 2, mobile: true, hasTouch: true },
  { id: 'pixel-9', label: 'Pixel 9', width: 412, height: 923, deviceScaleFactor: 2.625, mobile: true, hasTouch: true },
  { id: 'galaxy-s24', label: 'Galaxy S24', width: 360, height: 780, deviceScaleFactor: 3, mobile: true, hasTouch: true }
]

/** What the agent is allowed to name, plus the two that are not devices. */
export const DEVICE_IDS = DEVICES.map((d) => d.id)

export function clampDimension(value, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, n))
}

/**
 * Turn a request into the concrete metrics to emulate.
 *
 * `responsive` is the default and means "whatever the panel is" — the width and
 * height come from the surface that is drawing it, so they are required here
 * too and simply passed through. `custom` is the same numbers chosen by hand,
 * and is distinguished from `responsive` only by no longer following the panel.
 */
export function resolveDevice({ id, width, height, hostDpr = 1, by = 'user' }) {
  const dpr = Number.isFinite(hostDpr) && hostDpr > 0 ? hostDpr : 1

  if (id === 'responsive' || id === 'custom') {
    const w = clampDimension(width, 1280)
    const h = clampDimension(height, 800)
    return {
      id,
      label: id === 'responsive' ? 'Responsive' : `${w}×${h}`,
      width: w,
      height: h,
      deviceScaleFactor: dpr,
      mobile: false,
      hasTouch: false,
      by
    }
  }

  const preset = DEVICES.find((d) => d.id === id)
  if (!preset) {
    const names = DEVICE_IDS.join(', ')
    throw new Error(`Unknown device "${id}". Expected one of: ${names}, custom, responsive.`)
  }
  return {
    id: preset.id,
    label: preset.label,
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: preset.deviceScaleFactor ?? dpr,
    mobile: preset.mobile,
    hasTouch: preset.hasTouch,
    by
  }
}

/** Name a size somebody else set, so a resize done behind our back still shows
 *  up in the UI as something recognisable rather than as bare numbers. */
export function matchPreset(width, height) {
  return DEVICES.find((d) => d.width === width && d.height === height)?.id ?? 'custom'
}

/**
 * What the agent sees.
 *
 * Shaped like the tool objects `@playwright/mcp` emits, because it is merged
 * into the same `tools/list` reply. The enum is built from the table above, so
 * the list the menu offers and the list the model may name are the same list
 * and cannot drift.
 *
 * One required field on purpose: the model cannot get `device` wrong, and
 * `custom` is the documented way out when it wants a size of its own.
 */
export const DEVICE_TOOL = {
  name: 'browser_device',
  description:
    "Render this chat's browser tab at a device size. `responsive` is the default and " +
    'means the page fills the panel and reflows as the user resizes it. A phone or tablet ' +
    'id also sets the device pixel ratio, the mobile flag and touch emulation, so the page ' +
    'serves its real mobile layout rather than a desktop one squeezed narrow. `custom` ' +
    'takes width and height in CSS pixels. The user watches the panel reframe as you do ' +
    'this and the size is labelled in their address bar, so say why you are switching, and ' +
    'put it back to `responsive` when you have finished looking. Anything you snapshotted ' +
    'before this call describes the old size.',
  inputSchema: {
    type: 'object',
    properties: {
      device: {
        type: 'string',
        enum: [...DEVICE_IDS, 'custom', 'responsive'],
        description: 'A device id, `custom` with width and height, or `responsive`.'
      },
      width: {
        type: 'number',
        description: `CSS pixels, ${MIN_DIMENSION}-${MAX_DIMENSION}. Required for \`custom\`, ignored otherwise.`
      },
      height: {
        type: 'number',
        description: `CSS pixels, ${MIN_DIMENSION}-${MAX_DIMENSION}. Required for \`custom\`, ignored otherwise.`
      }
    },
    required: ['device'],
    additionalProperties: false
  },
  annotations: {
    title: 'Set the emulated device',
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false
  }
}
