import { afterEach, describe, expect, it } from 'vitest'
import fixture from '@shared/wsl-paths.json'
import { tildeInEnv, toHostPath, wslShare } from '@renderer/lib/environment'
import { resolvePath } from '@renderer/lib/paths'
import { setPlatformForTest } from '@renderer/lib/platform'

// The same table Rust runs (`environment::tests`). The renderer only maps WSL
// paths to host paths, so it takes `detect` and `toHost` and leaves `toEnv`.
type Detect = { cwd: string; distro: string | null; share?: string }
type ToHost = { cwd: string; path: string; host: string }

afterEach(() => setPlatformForTest(null))

describe('the shared WSL fixture', () => {
  it.each(fixture.detect as Detect[])('detects the distro of $cwd', ({ cwd, distro, share }) => {
    setPlatformForTest('windows')
    const found = wslShare(cwd)
    if (distro === null) {
      expect(found).toBeNull()
    } else {
      expect(found).toEqual({ distro, prefix: share })
    }
  })

  it.each(fixture.toHost as ToHost[])('maps $path in $cwd', ({ cwd, path, host }) => {
    setPlatformForTest('windows')
    expect(toHostPath(cwd, path)).toBe(host)
  })
})

describe('outside Windows', () => {
  it('has no WSL projects, so nothing is mapped', () => {
    setPlatformForTest('mac')
    expect(wslShare('//wsl.localhost/Ubuntu/home/me')).toBeNull()
    expect(toHostPath('//wsl.localhost/Ubuntu/home/me', '/home/me/a.ts')).toBe('/home/me/a.ts')
  })
})

describe('resolvePath in a WSL chat', () => {
  const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

  it('names what Claude printed the way the project is named', () => {
    setPlatformForTest('windows')
    expect(resolvePath('/home/me/repo/src/a.ts', cwd)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src\\a.ts'
    )
    expect(resolvePath('/mnt/c/Users/me/x.png', cwd)).toBe('C:\\Users\\me\\x.png')
  })

  it('still joins a relative path onto the cwd', () => {
    setPlatformForTest('windows')
    expect(resolvePath('./src/a.ts', cwd)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src\\a.ts')
  })

  it('leaves a host chat exactly as it was', () => {
    setPlatformForTest('windows')
    expect(resolvePath('/tmp/x.png', 'C:\\Users\\me\\repo')).toBe('/tmp/x.png')
    setPlatformForTest('mac')
    expect(resolvePath('/tmp/x.png', '/Users/me/repo')).toBe('/tmp/x.png')
    expect(resolvePath('src/a.ts', '/Users/me/repo')).toBe('/Users/me/repo/src/a.ts')
  })
})

describe('tildeInEnv', () => {
  it('writes the home the way the distro’s shell does', () => {
    expect(tildeInEnv('/home/me/dev/mv-ui', '/home/me')).toBe('~/dev/mv-ui')
    expect(tildeInEnv('/home/me', '/home/me/')).toBe('~')
  })

  it('leaves a path outside the home, a sibling, or an unknown home alone', () => {
    expect(tildeInEnv('/srv/repo', '/home/me')).toBe('/srv/repo')
    expect(tildeInEnv('/home/meow/repo', '/home/me')).toBe('/home/meow/repo')
    expect(tildeInEnv('/home/me/repo', null)).toBe('/home/me/repo')
    expect(tildeInEnv('/tmp/x', '/')).toBe('/tmp/x')
  })
})
