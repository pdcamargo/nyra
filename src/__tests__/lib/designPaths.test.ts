import { afterEach, describe, expect, it } from 'vitest'
import {
  designPathInCommand,
  designPathInText,
  hostDesignPath,
  sameDesign
} from '@renderer/lib/designPaths'
import { setPlatformForTest } from '@renderer/lib/platform'

afterEach(() => setPlatformForTest(null))

describe('finding a design path in a shell command', () => {
  it('takes an absolute path, on any host', () => {
    expect(designPathInCommand('node fix.js C:/a/reel.nyui.json')).toBe('C:/a/reel.nyui.json')
    expect(designPathInCommand('node fix.js C:\\a\\reel.nyui.json')).toBe('C:\\a\\reel.nyui.json')
    expect(designPathInCommand('cat /Users/me/.nyra/designs/files/x.nyui.json')).toBe(
      '/Users/me/.nyra/designs/files/x.nyui.json'
    )
    expect(designPathInCommand('cat /mnt/c/Users/me/x.nyui.json')).toBe('/mnt/c/Users/me/x.nyui.json')
    expect(designPathInCommand('type \\\\wsl.localhost\\Ubuntu\\home\\me\\x.nyui.json')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\x.nyui.json'
    )
  })

  it('keeps the spaces in a quoted path', () => {
    expect(designPathInCommand('node s.js "C:\\Users\\John Doe\\x.nyui.json" --fix')).toBe(
      'C:\\Users\\John Doe\\x.nyui.json'
    )
    expect(designPathInCommand("cat '/Users/John Doe/x.nyui.json'")).toBe('/Users/John Doe/x.nyui.json')
  })

  it('never takes a bare name or the tail of a relative path', () => {
    expect(designPathInCommand('ls ~/.nyra/designs/files | grep reel-d_1.nyui.json')).toBeNull()
    expect(designPathInCommand('cat files/reel-d_1.nyui.json')).toBeNull()
    expect(designPathInCommand('cat ~/x.nyui.json')).toBeNull()
    expect(designPathInCommand('npm test')).toBeNull()
  })

  it('does not run on into the rest of the command', () => {
    expect(designPathInCommand('cd /repo && node s.js C:/x.nyui.json')).toBe('C:/x.nyui.json')
    expect(designPathInCommand('node s.js /a/x.nyui.json; echo done')).toBe('/a/x.nyui.json')
  })
})

describe('finding a design path in a tool answer', () => {
  it('reads a path at the start of a line, spaces and all', () => {
    const create = 'Registered "X" as d_1.\n\nWrite the document to:\nC:\\Users\\John Doe\\.nyra\\designs\\files\\x-d_1.nyui.json\n'
    expect(designPathInText(create)).toBe('C:\\Users\\John Doe\\.nyra\\designs\\files\\x-d_1.nyui.json')
    expect(designPathInText('/Users/me/.nyra/designs/files/x.nyui.json did not compile\nerror: …')).toBe(
      '/Users/me/.nyra/designs/files/x.nyui.json'
    )
  })

  it('finds nothing where there is nothing', () => {
    expect(designPathInText('Rendered "X":\n  a (a) — 100x100\n  C:\\tmp\\a-2x.png')).toBeNull()
    expect(designPathInText(undefined)).toBeNull()
  })
})

describe('one host path per design', () => {
  it('on Windows, folds every spelling of a file into one', () => {
    setPlatformForTest('windows')
    const cwd = 'C:\\repo'
    const want = 'C:\\Users\\me\\x.nyui.json'
    expect(hostDesignPath('C:\\Users\\me\\x.nyui.json', cwd)).toBe(want)
    expect(hostDesignPath('C:/Users/me/x.nyui.json', cwd)).toBe(want)
    expect(hostDesignPath('/c/Users/me/x.nyui.json', cwd)).toBe(want)
    expect(hostDesignPath('c:\\Users\\me\\x.nyui.json', cwd)).toBe(want)
    expect(hostDesignPath('designs/x.nyui.json', cwd)).toBe('C:\\repo\\designs\\x.nyui.json')
  })

  it('in a WSL chat, maps the distro and /mnt paths to the host', () => {
    setPlatformForTest('windows')
    const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    expect(hostDesignPath('/home/me/x.nyui.json', cwd)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\x.nyui.json')
    expect(hostDesignPath('/mnt/c/Users/me/x.nyui.json', cwd)).toBe('C:\\Users\\me\\x.nyui.json')
    // Nyra's own answers are host paths already and pass through untouched.
    expect(hostDesignPath('C:\\Users\\me\\.nyra\\designs\\files\\x.nyui.json', cwd)).toBe(
      'C:\\Users\\me\\.nyra\\designs\\files\\x.nyui.json'
    )
  })

  it('on macOS, leaves paths alone — /c is a directory there, not a drive', () => {
    setPlatformForTest('mac')
    const cwd = '/Users/me/repo'
    expect(hostDesignPath('/Users/me/x.nyui.json', cwd)).toBe('/Users/me/x.nyui.json')
    expect(hostDesignPath('/c/x.nyui.json', cwd)).toBe('/c/x.nyui.json')
    expect(hostDesignPath('designs/x.nyui.json', cwd)).toBe('/Users/me/repo/designs/x.nyui.json')
  })

  it('compares by the host rules', () => {
    setPlatformForTest('windows')
    expect(sameDesign('C:\\Users\\Me\\X.nyui.json', 'c:/users/me/x.nyui.json')).toBe(true)
    setPlatformForTest('mac')
    expect(sameDesign('/Users/Me/X.nyui.json', '/Users/me/x.nyui.json')).toBe(false)
    expect(sameDesign('/Users/me/x.nyui.json/', '/Users/me/x.nyui.json')).toBe(true)
  })
})
