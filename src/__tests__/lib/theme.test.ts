import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyThemeClass,
  bootTheme,
  persistedThemePreference,
  resolveTheme
} from '../../renderer/src/lib/theme'

function mockSystem(prefersLight: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('light') ? prefersLight : !prefersLight,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    mockSystem(false)
  })

  describe('applyThemeClass', () => {
    it('adds .dark for dark and removes it for light', () => {
      applyThemeClass('dark')
      expect(document.documentElement.classList.contains('dark')).toBe(true)
      applyThemeClass('light')
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })
  })

  describe('persistedThemePreference', () => {
    it('reads the preference out of the zustand persist envelope', () => {
      localStorage.setItem('nyra-settings', JSON.stringify({ state: { theme: 'light' } }))
      expect(persistedThemePreference()).toBe('light')
    })

    it('falls back to the default when nothing is stored', () => {
      expect(persistedThemePreference()).toBe('dark')
    })

    it('falls back when the blob is unparseable', () => {
      localStorage.setItem('nyra-settings', 'not json')
      expect(persistedThemePreference()).toBe('dark')
    })

    it('falls back when the stored value is not a theme', () => {
      localStorage.setItem('nyra-settings', JSON.stringify({ state: { theme: 'chartreuse' } }))
      expect(persistedThemePreference()).toBe('dark')
    })
  })

  describe('resolveTheme', () => {
    it('passes explicit preferences through', () => {
      expect(resolveTheme('light')).toBe('light')
      expect(resolveTheme('dark')).toBe('dark')
    })

    it('asks the system when the preference is system', () => {
      mockSystem(true)
      expect(resolveTheme('system')).toBe('light')
      mockSystem(false)
      expect(resolveTheme('system')).toBe('dark')
    })
  })

  describe('bootTheme', () => {
    it('applies the persisted light preference before render', () => {
      localStorage.setItem('nyra-settings', JSON.stringify({ state: { theme: 'light' } }))
      bootTheme()
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    it('applies dark when the preference is system and the system is dark', () => {
      localStorage.setItem('nyra-settings', JSON.stringify({ state: { theme: 'system' } }))
      mockSystem(false)
      bootTheme()
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
  })
})
