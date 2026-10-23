import { describe, expect, it } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { registerShaderLanguages } from '@renderer/lib/monacoShaders'

/** Just enough of `monaco.languages` to see what was registered. */
function fakeMonaco(): { monaco: typeof Monaco; registered: string[]; providers: Record<string, Monaco.languages.IMonarchLanguage> } {
  const registered: string[] = []
  const providers: Record<string, Monaco.languages.IMonarchLanguage> = {}
  const languages = {
    getLanguages: () => registered.map((id) => ({ id })),
    register: ({ id }: { id: string }) => registered.push(id),
    setMonarchTokensProvider: (id: string, language: Monaco.languages.IMonarchLanguage) => {
      providers[id] = language
    },
    setLanguageConfiguration: () => undefined
  }
  return { monaco: { languages } as unknown as typeof Monaco, registered, providers }
}

describe('shader languages for Monaco', () => {
  it('registers HLSL and GLSL once', () => {
    const { monaco, registered } = fakeMonaco()
    registerShaderLanguages(monaco)
    registerShaderLanguages(monaco)
    expect(registered).toEqual(['hlsl', 'glsl'])
  })

  it("knows each language's own types and built-ins", () => {
    const { monaco, providers } = fakeMonaco()
    registerShaderLanguages(monaco)
    const hlsl = providers.hlsl as unknown as { types: string[]; builtins: string[] }
    const glsl = providers.glsl as unknown as { types: string[]; builtins: string[] }
    expect(hlsl.types).toEqual(expect.arrayContaining(['float4', 'float4x4', 'Texture2D', 'RWStructuredBuffer']))
    expect(hlsl.builtins).toEqual(expect.arrayContaining(['mul', 'saturate', 'lerp']))
    expect(glsl.types).toEqual(expect.arrayContaining(['vec3', 'mat4', 'mat2x3', 'sampler2D', 'usampler2D']))
    expect(glsl.builtins).toEqual(expect.arrayContaining(['mix', 'fract', 'texture', 'gl_Position']))
  })
})
