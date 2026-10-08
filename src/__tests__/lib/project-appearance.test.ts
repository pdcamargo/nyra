import { describe, expect, it } from 'vitest'
import { projectIcon, tintColor, PROJECT_ICONS } from '@renderer/lib/project-appearance'

describe('project appearance', () => {
  it('reads a preset as its theme variable and a hex as itself', () => {
    expect(tintColor('blue')).toBe('var(--tint-blue)')
    expect(tintColor('#B45309')).toBe('#B45309')
  })

  it('draws anything else as no colour', () => {
    expect(tintColor(undefined)).toBeNull()
    expect(tintColor('teal')).toBeNull()
    expect(tintColor('#fff')).toBeNull()
    expect(tintColor('red; background: url(x)')).toBeNull()
  })

  it('falls back to the folder for an unknown or missing icon', () => {
    expect(projectIcon('rocket')).toBe(PROJECT_ICONS.rocket)
    expect(projectIcon('not-an-icon')).toBeNull()
    expect(projectIcon(undefined)).toBeNull()
  })
})
