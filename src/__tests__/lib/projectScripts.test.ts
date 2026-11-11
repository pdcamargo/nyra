import { describe, expect, it } from 'vitest'
import { parseScriptsFile, pickRunScript, runScriptCommand } from '../../renderer/src/lib/projectScripts'
import { tailLines } from '../../renderer/src/store/scripts'

describe('parseScriptsFile', () => {
  it('reads both scripts, and an array as lines', () => {
    expect(parseScriptsFile('{"setup": ["npm install", "cp $NYRA_ROOT_PATH/.env ."], "run": "npm run dev"}')).toEqual({
      setup: 'npm install\ncp $NYRA_ROOT_PATH/.env .',
      run: 'npm run dev'
    })
  })

  it('leaves out a blank or mistyped script', () => {
    expect(parseScriptsFile('{"setup": "  ", "run": 3}')).toEqual({})
  })

  it('is null for anything that is not a JSON object', () => {
    expect(parseScriptsFile('not json')).toBeNull()
    expect(parseScriptsFile('["npm install"]')).toBeNull()
  })
})

describe('detecting a Run command', () => {
  it('prefers dev to start', () => {
    expect(pickRunScript({ start: 'node .', dev: 'vite' })).toBe('dev')
    expect(pickRunScript({ start: 'node .' })).toBe('start')
    expect(pickRunScript({ build: 'tsc' })).toBeNull()
  })

  it('says it the way each package manager does', () => {
    expect(runScriptCommand('npm', 'dev')).toBe('npm run dev')
    expect(runScriptCommand('bun', 'dev')).toBe('bun run dev')
    expect(runScriptCommand('pnpm', 'dev')).toBe('pnpm dev')
    expect(runScriptCommand('yarn', 'start')).toBe('yarn start')
  })
})

describe('tailLines', () => {
  it('strips colour and keeps a redrawn line at its last state', () => {
    const raw = '\x1b[32mVITE\x1b[0m ready\r\nprogress 10%\rprogress 100%\r\n\x1b]0;title\x07  ➜  Local: http://localhost:5173/\r\n'
    expect(tailLines(raw, 5)).toEqual(['VITE ready', 'progress 100%', '  ➜  Local: http://localhost:5173/'])
  })

  it('keeps only the last n', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual(['b', 'c'])
  })
})
