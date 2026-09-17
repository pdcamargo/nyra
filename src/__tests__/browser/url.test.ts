import { describe, expect, it } from 'vitest'
import { displayUrl, toUrl } from '../../renderer/src/components/browser/url'

describe('toUrl', () => {
  it('leaves anything with a scheme alone', () => {
    expect(toUrl('https://example.com')).toBe('https://example.com')
    expect(toUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x')
    expect(toUrl('about:blank')).toBe('about:blank')
  })

  it('reads a bare port as the dev server it almost always is', () => {
    expect(toUrl(':5173')).toBe('http://localhost:5173')
    expect(toUrl(':5173/login')).toBe('http://localhost:5173/login')
  })

  it('keeps loopback on http, because nobody serves TLS there', () => {
    expect(toUrl('localhost:1420')).toBe('http://localhost:1420')
    expect(toUrl('127.0.0.1:8787/health')).toBe('http://127.0.0.1:8787/health')
  })

  it('assumes https for a plain host', () => {
    expect(toUrl('example.com')).toBe('https://example.com')
    expect(toUrl('github.com/microsoft/playwright')).toBe('https://github.com/microsoft/playwright')
  })

  it('searches for something that is not a host', () => {
    expect(toUrl('how to pin a viewport')).toContain('duckduckgo.com/?q=')
    expect(toUrl('how to pin a viewport')).toContain('how%20to%20pin%20a%20viewport')
  })

  it('treats empty input as a blank tab rather than a search for nothing', () => {
    expect(toUrl('   ')).toBe('about:blank')
  })
})

describe('displayUrl', () => {
  it('shows an empty bar for a blank tab', () => {
    expect(displayUrl('about:blank')).toBe('')
    expect(displayUrl('https://example.com')).toBe('https://example.com')
  })
})
