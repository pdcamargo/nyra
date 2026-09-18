import { afterEach, describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEPS, clampZoom, nextZoom, persistedZoom } from '@renderer/lib/zoom'

describe('nextZoom', () => {
  it('walks the ladder', () => {
    expect(nextZoom(1, 1)).toBe(1.1)
    expect(nextZoom(1, -1)).toBe(0.9)
    expect(nextZoom(1.25, 1)).toBe(1.5)
  })

  it('clamps at both ends', () => {
    expect(nextZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(nextZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
  })

  it('snaps a value that is not on the ladder', () => {
    expect(nextZoom(1.05, 1)).toBe(1.1)
    expect(nextZoom(1.05, -1)).toBe(1)
  })

  it('reaches every step', () => {
    let z: number = MIN_ZOOM
    const walked: number[] = [z]
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      z = nextZoom(z, 1)
      if (walked[walked.length - 1] !== z) walked.push(z)
    }
    expect(walked).toEqual([...ZOOM_STEPS])
  })
})

describe('clampZoom', () => {
  it('holds the range and survives nonsense', () => {
    expect(clampZoom(5)).toBe(MAX_ZOOM)
    expect(clampZoom(0.1)).toBe(MIN_ZOOM)
    expect(clampZoom('big')).toBe(1)
    expect(clampZoom(NaN)).toBe(1)
    expect(clampZoom(undefined)).toBe(1)
  })
})

describe('persistedZoom', () => {
  afterEach(() => localStorage.removeItem('nyra-settings'))

  it('defaults when there is nothing stored', () => {
    expect(persistedZoom()).toBe(1)
  })

  it('reads the zustand envelope', () => {
    localStorage.setItem('nyra-settings', JSON.stringify({ state: { zoom: 1.25 } }))
    expect(persistedZoom()).toBe(1.25)
  })

  it('survives unparseable storage and a non-numeric value', () => {
    localStorage.setItem('nyra-settings', '{not json')
    expect(persistedZoom()).toBe(1)
    localStorage.setItem('nyra-settings', JSON.stringify({ state: { zoom: 'huge' } }))
    expect(persistedZoom()).toBe(1)
  })
})
