import { describe, it, expect } from 'vitest'
import { ICON_LIBRARY, pickAgentIcon } from '../../renderer/src/utils/agentIcons'

describe('pickAgentIcon', () => {
  it('matches by name keyword', () => {
    expect(pickAgentIcon('code-reviewer', '')).toBe(ICON_LIBRARY.review)
    expect(pickAgentIcon('product-designer', '')).toBe(ICON_LIBRARY.design)
    expect(pickAgentIcon('senior-architect', '')).toBe(ICON_LIBRARY.architect)
  })

  it('matches by description keyword when name is generic', () => {
    expect(pickAgentIcon('helper', 'Pentest and vuln scanning specialist')).toBe(
      ICON_LIBRARY.security
    )
    expect(pickAgentIcon('helper', 'Investigates and analyzes existing patterns')).toBe(
      ICON_LIBRARY.research
    )
  })

  it('falls back to default for unknown agents', () => {
    expect(pickAgentIcon('xyz-frobnicator', 'does some thing')).toBe(ICON_LIBRARY.default)
  })

  it('is case-insensitive', () => {
    expect(pickAgentIcon('SECURITY-AUDITOR', '')).toBe(pickAgentIcon('security-auditor', ''))
  })

  it('tones come from the theme, not the raw palette', () => {
    for (const icon of Object.values(ICON_LIBRARY)) {
      expect(icon.tone).not.toMatch(/-(blue|red|green|amber|yellow|purple|violet|pink|cyan|teal|emerald|orange|indigo|sky)-\d/)
    }
  })
})
