import { basename } from '../lib/paths'
import { structuredPatch } from 'diff'

export type DiffData = {
  filePath: string
  original: string
  modified: string
  isNewFile: boolean
}

export function buildDiffFromToolInput(
  toolName: string,
  input: Record<string, unknown>,
  originalContent?: string | null
): DiffData | null {
  const filePath = String(input.file_path ?? input.path ?? '')
  if (!filePath) return null

  if (toolName === 'Edit') {
    const oldStr = String(input.old_string ?? '')
    const newStr = String(input.new_string ?? '')
    if (!oldStr && !newStr) return null
    return { filePath, original: oldStr, modified: newStr, isNewFile: false }
  }

  if (toolName === 'Write') {
    const content = String(input.content ?? '')
    const isNewFile = originalContent == null || originalContent === ''
    return {
      filePath,
      original: originalContent ?? '',
      modified: content,
      isNewFile
    }
  }

  return null
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  // Shaders. WGSL is Monaco's own; HLSL and GLSL are registered in
  // `monacoShaders.ts`. Slang and Unreal's .usf are HLSL with extras, Godot's
  // shading language and Unity's ShaderLab read close enough to GLSL and HLSL,
  // and Metal is C++ underneath.
  wgsl: 'wgsl',
  hlsl: 'hlsl',
  hlsli: 'hlsl',
  fx: 'hlsl',
  fxh: 'hlsl',
  slang: 'hlsl',
  usf: 'hlsl',
  ush: 'hlsl',
  shader: 'hlsl',
  cginc: 'hlsl',
  glsl: 'glsl',
  vert: 'glsl',
  frag: 'glsl',
  geom: 'glsl',
  comp: 'glsl',
  tesc: 'glsl',
  tese: 'glsl',
  gdshader: 'glsl',
  metal: 'cpp'
}

export function detectLanguage(filePath: string): string {
  const name = basename(filePath).toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const ext = name.split('.').pop() ?? ''
  return EXT_TO_LANG[ext] ?? 'plaintext'
}

/**
 * Two versions of a file as the one patch `DiffView` draws: a git-style header
 * and every hunk. The view computes nothing on its own — given contents and no
 * hunks it draws an empty table — so a pair of blobs needs this first. Empty
 * when the two are the same.
 */
export function unifiedHunks(fileName: string, original: string, modified: string, context = 3): string[] {
  const patch = structuredPatch(fileName, fileName, original, modified, '', '', { context })
  if (patch.hunks.length === 0) return []
  // An empty side starts at the line before it, as git writes it: `-0,0`.
  const at = (start: number, lines: number): string => `${lines === 0 ? Math.max(0, start - 1) : start},${lines}`
  const body = patch.hunks
    .map((h) => [`@@ -${at(h.oldStart, h.oldLines)} +${at(h.newStart, h.newLines)} @@`, ...h.lines].join('\n'))
    .join('\n')
  return [`--- a/${fileName}\n+++ b/${fileName}\n${body}\n`]
}
