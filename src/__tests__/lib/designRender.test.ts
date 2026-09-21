import { describe, expect, it } from 'vitest'
import { renderFailure } from '@renderer/lib/designRender'

/**
 * The first render on a machine launches a headless Chromium. Someone with no
 * Chrome who declined the 182 MB download used to get the sidecar's raw probe
 * error, which reads like a crash and says nothing about what to do next.
 */
describe('why a render failed', () => {
  it.each([
    "Chromium is not installed. Run `npx playwright install chromium`.",
    "browser is not installed",
    "Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1234"
  ])('explains a missing browser: %s', (raw) => {
    const text = renderFailure('login', raw)
    expect(text).toMatch(/needs a browser/)
    expect(text).toMatch(/Browser panel/)
    // The design is not lost, and saying so is the difference between "try
    // again" and "start over".
    expect(text).toMatch(/design itself is fine/)
    // The original is kept, because a friendlier wrapper that hides the cause
    // is worse than no wrapper.
    expect(text).toContain(raw)
  })

  it('passes an unrelated failure straight through', () => {
    const text = renderFailure('login', 'rendered html has no [data-artboard] element')
    expect(text).toBe('Could not render "login": rendered html has no [data-artboard] element')
    expect(text).not.toMatch(/needs a browser/)
  })

  it('says something useful when there is no error at all', () => {
    expect(renderFailure('login', undefined)).toMatch(/did not answer/)
  })
})
