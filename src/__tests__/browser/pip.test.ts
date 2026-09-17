import { describe, expect, it } from 'vitest'
import { pipVisible } from '../../renderer/src/components/browser/BrowserPip'

const showing = {
  enabled: true,
  hasSession: true,
  phase: 'ready' as const,
  tabCount: 2,
  dismissed: false,
  rightPanelOpen: false
}

describe('pipVisible', () => {
  it('floats a miniature when the browser is running and out of sight', () => {
    expect(pipVisible(showing)).toBe(true)
  })

  it('stays out of the way when the panel is already showing the browser', () => {
    // The panel is the browser now, so its being open is the whole test — there
    // are no workspace tabs left for it to be open on instead.
    expect(pipVisible({ ...showing, rightPanelOpen: true })).toBe(false)
  })

  it('stays hidden once dismissed, until the Summary brings it back', () => {
    expect(pipVisible({ ...showing, dismissed: true })).toBe(false)
  })

  it('needs a browser that is actually up, with something in it', () => {
    expect(pipVisible({ ...showing, phase: 'off' })).toBe(false)
    expect(pipVisible({ ...showing, phase: 'starting' })).toBe(false)
    expect(pipVisible({ ...showing, tabCount: 0 })).toBe(false)
  })

  it('honours the global switch', () => {
    expect(pipVisible({ ...showing, enabled: false })).toBe(false)
  })

  it('shows nothing with no chat on screen', () => {
    expect(pipVisible({ ...showing, hasSession: false })).toBe(false)
  })
})
