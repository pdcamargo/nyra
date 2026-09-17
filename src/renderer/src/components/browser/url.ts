/**
 * What to do with whatever was typed in the URL bar.
 *
 * A dev server is the common case here, so `localhost:5173` and `:5173` have to
 * mean what the person meant rather than becoming a search. Anything that is
 * plainly not a host gets searched, because failing to a "server not found"
 * page is a worse answer than looking it up.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i
/** A scheme, but not a host with a port on it: `localhost:1420` and
 *  `example.com:8080` both look exactly like `scheme:rest` and neither is one.
 *  What tells them apart is that a port is digits and a scheme's body is not. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i
const LOOKS_LIKE_HOST = /^[^\s/]+\.[^\s/]{2,}(:\d+)?(\/|$)/

export function toUrl(input: string): string {
  const text = input.trim()
  if (!text) return 'about:blank'
  if (HAS_SCHEME.test(text)) return text
  // A bare port is a dev server nine times out of ten.
  if (/^:\d+/.test(text)) return `http://localhost${text}`
  if (LOOPBACK.test(text)) return `http://${text}`
  if (LOOKS_LIKE_HOST.test(text)) return `https://${text}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`
}

/** What to show in the bar. `about:blank` is noise on an empty tab. */
export function displayUrl(url: string): string {
  return url === 'about:blank' ? '' : url
}
