import { afterEach, describe, expect, it } from 'vitest'
import {
  basename,
  dirname,
  isAbsolute,
  isWithin,
  joinPath,
  relativeTo,
  resolvePath,
  samePath,
  segments,
  shortenPath,
  tail,
  trimTrailingSep
} from '@renderer/lib/paths'
import { detectOs, platform, setPlatformForTest } from '@renderer/lib/platform'

afterEach(() => setPlatformForTest(null))

describe('detectOs', () => {
  it('reads each webview’s own user agent', () => {
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('mac')
    expect(
      detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Edg/128.0')
    ).toBe('windows')
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')).toBe('linux')
  })

  it('answers every trait for every OS', () => {
    for (const os of ['mac', 'windows', 'linux'] as const) {
      setPlatformForTest(os)
      expect(platform().os).toBe(os)
      expect(platform().revealLabel).not.toBe('')
    }
  })
})

describe('posix paths', () => {
  it('splits a path into a directory and a name', () => {
    setPlatformForTest('mac')
    expect(basename('/repo/src/a.ts')).toBe('a.ts')
    expect(basename('/repo/src/')).toBe('src')
    expect(basename('/')).toBe('')
    expect(dirname('/repo/src/a.ts')).toBe('/repo/src')
    expect(dirname('/a.ts')).toBe('/')
  })

  it('treats a backslash as part of a name, which it is here', () => {
    setPlatformForTest('mac')
    expect(basename('/repo/odd\\name')).toBe('odd\\name')
    expect(isAbsolute('C:\\Users')).toBe(false)
  })

  it('joins and relativises without doubling separators', () => {
    setPlatformForTest('linux')
    expect(joinPath('/repo/', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(joinPath('/', 'etc')).toBe('/etc')
    expect(relativeTo('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/repo', '/repo-two/a.ts')).toBe('/repo-two/a.ts')
    expect(isWithin('/repo', '/repo-two')).toBe(false)
  })

  it('is case-sensitive', () => {
    setPlatformForTest('linux')
    expect(samePath('/Repo', '/repo')).toBe(false)
  })
})

describe('windows paths', () => {
  it('splits on either slash', () => {
    setPlatformForTest('windows')
    expect(basename('C:\\Users\\me\\repo\\a.ts')).toBe('a.ts')
    expect(basename('C:/Users/me/repo/')).toBe('repo')
    expect(segments('C:\\Users\\me')).toEqual(['C:', 'Users', 'me'])
    expect(dirname('C:\\Users\\me')).toBe('C:\\Users')
  })

  it('keeps a drive root and a share root whole', () => {
    setPlatformForTest('windows')
    expect(dirname('C:\\a.ts')).toBe('C:\\')
    expect(trimTrailingSep('C:\\')).toBe('C:\\')
    expect(basename('C:\\')).toBe('')
    expect(basename('\\\\server\\share\\a.txt')).toBe('a.txt')
    expect(dirname('\\\\server\\share\\a.txt')).toBe('\\\\server\\share\\')
  })

  it('knows a drive path, a share and a rooted path are absolute', () => {
    setPlatformForTest('windows')
    expect(isAbsolute('C:\\Users')).toBe(true)
    expect(isAbsolute('c:/Users')).toBe(true)
    expect(isAbsolute('\\\\server\\share')).toBe(true)
    expect(isAbsolute('src\\a.ts')).toBe(false)
    expect(isAbsolute('C:relative')).toBe(false)
  })

  it('joins in the separator the root already uses', () => {
    setPlatformForTest('windows')
    expect(joinPath('C:\\repo', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts')
    expect(joinPath('C:/repo', 'src\\a.ts')).toBe('C:/repo/src/a.ts')
    expect(joinPath('C:\\', 'repo')).toBe('C:\\repo')
    expect(resolvePath('.\\notes.md', 'C:\\repo')).toBe('C:\\repo\\notes.md')
    expect(resolvePath('D:\\elsewhere\\x.md', 'C:\\repo')).toBe('D:\\elsewhere\\x.md')
  })

  // What `git worktree list` prints against what Nyra holds.
  it('compares across slashes and case', () => {
    setPlatformForTest('windows')
    expect(samePath('C:/Users/Me/Repo', 'c:\\users\\me\\repo\\')).toBe(true)
    expect(isWithin('C:/Users/me/repo', 'C:\\Users\\me\\repo\\src')).toBe(true)
    expect(isWithin('C:\\repo', 'C:\\repo-two')).toBe(false)
    expect(relativeTo('C:/repo', 'c:\\Repo\\src\\a.ts')).toBe('src\\a.ts')
  })

  it('shortens in the path’s own separator', () => {
    setPlatformForTest('windows')
    expect(tail('C:\\Users\\me\\dev\\nyra', 2)).toBe('dev\\nyra')
    expect(shortenPath('C:\\Users\\me\\dev\\nyra', 2)).toBe('…\\dev\\nyra')
    expect(shortenPath('C:\\a', 2)).toBe('C:\\a')
  })
})
