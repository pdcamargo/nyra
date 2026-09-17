import { describe, expect, it } from 'vitest'
import { pipVisible } from '../../renderer/src/components/browser/BrowserPip'

const showing = {
  enabled: true,
  hasSession: true,
  phase: 'ready' as const,
  tabCount: 2,
  dismissed: false,
  rightPanelOpen: false,
  rightPanelMode: 'workspace' as const
}

describe('pipVisible', () => {
  it('floats a miniature when the browser is running and out of sight', () => {
    expect(pipVisible(showing)).toBe(true)
  })

  it('stays out of the way when the panel is already showing the browser', () => {
    expect(pipVisible({ ...showing, rightPanelOpen: true, rightPanelMode: 'browser' })).toBe(false)
  })

  it('still shows when the panel is open on the workspace tabs', () => {
    // The panel being open is not the point — the browser being visible is.
    expect(pipVisible({ ...showing, rightPanelOpen: true, rightPanelMode: 'workspace' })).toBe(true)
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
