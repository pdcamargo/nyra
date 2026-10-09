/**
 * Which OS the renderer is running on, and everything that follows from it.
 *
 * Components never ask "is this Windows?". They read a trait — how paths are
 * written, who draws the window buttons, what the file manager is called — and
 * each OS answers every trait in one row of `TRAITS`. Adding an OS is adding a
 * row; the type makes a missing answer a compile error rather than an `if`
 * someone forgot to write.
 *
 * Detected from the user agent: synchronous, so the first render is already
 * right, and each webview says it plainly — WKWebView "Macintosh", WebView2
 * "Windows NT", WebKitGTK "Linux".
 */

export type Os = 'mac' | 'windows' | 'linux'

export type PlatformTraits = {
  os: Os
  /** `posix`: `/` only. `win32`: either slash, drive letters, case-insensitive. */
  pathStyle: 'posix' | 'win32'
  /**
   * Who draws close/minimise/maximise. `traffic-lights`: macOS, over the left
   * of our title bar, which has to leave room. `drawn`: nobody but us — the
   * window is undecorated and the title bar carries its own. `system`: a native
   * frame above the web content, so the title bar reserves nothing.
   */
  windowControls: 'traffic-lights' | 'drawn' | 'system'
  /** The menu item that shows a file in the OS file manager. */
  revealLabel: string
  /** What to call the machine in a sentence: "keep this Mac awake". */
  machineNoun: string
  /** The OS by name, for copy that says what it does or does not ask for. */
  osName: string
}

const TRAITS: Record<Os, PlatformTraits> = {
  mac: {
    os: 'mac',
    pathStyle: 'posix',
    windowControls: 'traffic-lights',
    revealLabel: 'Reveal in Finder',
    machineNoun: 'Mac',
    osName: 'macOS'
  },
  windows: {
    os: 'windows',
    pathStyle: 'win32',
    windowControls: 'drawn',
    revealLabel: 'Reveal in File Explorer',
    machineNoun: 'PC',
    osName: 'Windows'
  },
  linux: {
    os: 'linux',
    pathStyle: 'posix',
    windowControls: 'system',
    revealLabel: 'Open containing folder',
    machineNoun: 'computer',
    osName: 'Linux'
  }
}

export function detectOs(userAgent: string): Os {
  if (/Mac|iPhone|iPad|iPod/.test(userAgent)) return 'mac'
  if (/Windows NT/.test(userAgent)) return 'windows'
  return 'linux'
}

let cached: PlatformTraits | null = null

export function platform(): PlatformTraits {
  if (cached) return cached
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  cached = TRAITS[detectOs(ua)]
  return cached
}

/** Test seam: pin an OS, or `null` to go back to detecting it. */
export function setPlatformForTest(os: Os | null): void {
  cached = os ? TRAITS[os] : null
}
