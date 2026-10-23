/**
 * HLSL and GLSL for Monaco, which ships WGSL but neither of these.
 *
 * One C-shaped tokenizer, given each language's own words: keywords, types and
 * built-in functions. That is all a read-only viewer needs — there is no
 * language service anywhere in the app (see `monacoEnv.ts`), so this colours
 * text and does nothing else.
 */
import type * as Monaco from 'monaco-editor'

/** `float`, `float2` … `float4`, `float2x2` … `float4x4` — every shape of a scalar. */
function shapes(scalars: string[], vector: (s: string, n: number) => string, matrix?: (s: string, r: number, c: number) => string): string[] {
  const out: string[] = []
  for (const s of scalars) {
    for (let n = 2; n <= 4; n++) out.push(vector(s, n))
    if (matrix) for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) out.push(matrix(s, r, c))
  }
  return out
}

const CONTROL = ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'discard']
const COMMON_KEYWORDS = [...CONTROL, 'struct', 'const', 'static', 'inline', 'in', 'out', 'inout', 'uniform', 'true', 'false']

/** Math every shading language spells the same way. */
const COMMON_BUILTINS = [
  'abs', 'acos', 'all', 'any', 'asin', 'atan', 'ceil', 'clamp', 'cos', 'cosh', 'cross', 'degrees', 'determinant',
  'distance', 'dot', 'exp', 'exp2', 'faceforward', 'floor', 'fma', 'fwidth', 'isinf', 'isnan', 'ldexp', 'length',
  'log', 'log2', 'max', 'min', 'modf', 'normalize', 'pow', 'radians', 'reflect', 'refract', 'round', 'sign', 'sin',
  'sinh', 'smoothstep', 'sqrt', 'step', 'tan', 'tanh', 'transpose', 'trunc'
]

const HLSL = {
  keywords: [
    ...COMMON_KEYWORDS,
    'cbuffer', 'tbuffer', 'register', 'packoffset', 'groupshared', 'nointerpolation', 'linear', 'centroid',
    'noperspective', 'sample', 'precise', 'row_major', 'column_major', 'extern', 'shared', 'volatile', 'typedef',
    'namespace', 'template', 'typename', 'technique', 'technique11', 'pass', 'compile', 'snorm', 'unorm', 'point',
    'line', 'triangle', 'lineadj', 'triangleadj', 'indices', 'vertices', 'primitives', 'payload'
  ],
  types: [
    'void', 'bool', 'int', 'uint', 'dword', 'half', 'float', 'double', 'min16float', 'min10float', 'min16int',
    'min12int', 'min16uint', 'int16_t', 'uint16_t', 'int64_t', 'uint64_t', 'float16_t', 'float64_t', 'matrix',
    'vector', 'string',
    ...shapes(['bool', 'int', 'uint', 'half', 'float', 'double', 'min16float', 'min16int', 'min16uint'], (s, n) => `${s}${n}`, (s, r, c) => `${s}${r}x${c}`),
    'Texture1D', 'Texture1DArray', 'Texture2D', 'Texture2DArray', 'Texture2DMS', 'Texture2DMSArray', 'Texture3D',
    'TextureCube', 'TextureCubeArray', 'RWTexture1D', 'RWTexture1DArray', 'RWTexture2D', 'RWTexture2DArray',
    'RWTexture3D', 'Buffer', 'RWBuffer', 'StructuredBuffer', 'RWStructuredBuffer', 'AppendStructuredBuffer',
    'ConsumeStructuredBuffer', 'ByteAddressBuffer', 'RWByteAddressBuffer', 'ConstantBuffer', 'SamplerState',
    'SamplerComparisonState', 'sampler', 'sampler2D', 'sampler3D', 'samplerCUBE', 'RaytracingAccelerationStructure',
    'RayDesc', 'InputPatch', 'OutputPatch', 'PointStream', 'LineStream', 'TriangleStream'
  ],
  builtins: [
    ...COMMON_BUILTINS,
    'asfloat', 'asint', 'asuint', 'atan2', 'clip', 'countbits', 'ddx', 'ddx_coarse', 'ddx_fine', 'ddy',
    'ddy_coarse', 'ddy_fine', 'firstbithigh', 'firstbitlow', 'fmod', 'frac', 'frexp', 'lerp', 'lit', 'log10',
    'mad', 'mul', 'noise', 'rcp', 'reversebits', 'rsqrt', 'saturate', 'sincos', 'f16tof32', 'f32tof16',
    'GroupMemoryBarrierWithGroupSync', 'DeviceMemoryBarrier', 'AllMemoryBarrierWithGroupSync', 'InterlockedAdd',
    'InterlockedMax', 'InterlockedMin', 'InterlockedOr', 'InterlockedAnd', 'InterlockedExchange',
    'InterlockedCompareExchange', 'WaveActiveSum', 'WaveReadLaneFirst', 'WaveGetLaneIndex', 'TraceRay',
    'Sample', 'SampleLevel', 'SampleGrad', 'SampleBias', 'SampleCmp', 'SampleCmpLevelZero', 'Load', 'Store',
    'Gather', 'GetDimensions', 'tex2D', 'tex2Dlod', 'tex3D', 'texCUBE', 'numthreads'
  ]
}

const GLSL = {
  keywords: [
    ...COMMON_KEYWORDS,
    'layout', 'attribute', 'varying', 'buffer', 'shared', 'precision', 'highp', 'mediump', 'lowp', 'flat',
    'smooth', 'noperspective', 'centroid', 'sample', 'patch', 'invariant', 'precise', 'coherent', 'volatile',
    'restrict', 'readonly', 'writeonly', 'subroutine', 'location', 'binding', 'set', 'std140', 'std430',
    'push_constant', 'local_size_x', 'local_size_y', 'local_size_z'
  ],
  types: [
    'void', 'bool', 'int', 'uint', 'float', 'double', 'atomic_uint',
    ...shapes(['vec', 'bvec', 'ivec', 'uvec', 'dvec'], (s, n) => `${s}${n}`),
    ...shapes(['mat', 'dmat'], (s, n) => `${s}${n}`, (s, r, c) => `${s}${r}x${c}`),
    ...['', 'i', 'u'].flatMap((p) =>
      ['1D', '2D', '3D', 'Cube', '2DRect', '1DArray', '2DArray', 'CubeArray', 'Buffer', '2DMS', '2DMSArray'].flatMap(
        (d) => [`${p}sampler${d}`, `${p}image${d}`, `${p}texture${d}`]
      )
    ),
    'sampler1DShadow', 'sampler2DShadow', 'samplerCubeShadow', 'sampler2DArrayShadow', 'sampler', 'samplerShadow',
    'subpassInput'
  ],
  builtins: [
    ...COMMON_BUILTINS,
    'dFdx', 'dFdy', 'dFdxCoarse', 'dFdxFine', 'dFdyCoarse', 'dFdyFine', 'fract', 'inversesqrt', 'inverse', 'mix',
    'mod', 'outerProduct', 'matrixCompMult', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
    'equal', 'notEqual', 'not', 'packUnorm2x16', 'unpackUnorm2x16', 'floatBitsToInt', 'intBitsToFloat',
    'texture', 'textureLod', 'textureGrad', 'textureOffset', 'textureProj', 'textureSize', 'texelFetch',
    'textureGather', 'imageLoad', 'imageStore', 'imageSize', 'atomicAdd', 'atomicMax', 'atomicMin',
    'atomicExchange', 'atomicCompSwap', 'barrier', 'memoryBarrier', 'groupMemoryBarrier', 'emitVertex',
    'EmitVertex', 'EndPrimitive', 'gl_Position', 'gl_FragCoord', 'gl_FragDepth', 'gl_VertexID', 'gl_InstanceID',
    'gl_VertexIndex', 'gl_InstanceIndex', 'gl_GlobalInvocationID', 'gl_LocalInvocationID', 'gl_WorkGroupID',
    'gl_FrontFacing', 'gl_PointCoord', 'gl_PointSize'
  ]
}

function tokenizer(words: { keywords: string[]; types: string[]; builtins: string[] }): Monaco.languages.IMonarchLanguage {
  return {
    defaultToken: '',
    ...words,
    tokenizer: {
      root: [
        [/^\s*#\s*\w+/, 'keyword.directive'],
        // HLSL's system-value semantics, `: SV_Position`.
        [/\bSV_\w+/, 'predefined'],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@types': 'type', '@builtins': 'predefined', '@default': 'identifier' } }],
        { include: '@whitespace' },
        [/[{}()[\]]/, '@brackets'],
        [/\d*\.\d+([eE][-+]?\d+)?[fFhHlL]?/, 'number.float'],
        [/\d+\.\d*([eE][-+]?\d+)?[fFhHlL]?/, 'number.float'],
        [/0[xX][0-9a-fA-F]+[uUlL]*/, 'number.hex'],
        [/\d+[uUlL]*/, 'number'],
        [/[;,.]/, 'delimiter'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/[=><!~?:&|+\-*/^%]+/, 'operator']
      ],
      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment']
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment']
      ]
    }
  }
}

const configuration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' }
  ]
}

export function registerShaderLanguages(monaco: typeof Monaco): void {
  for (const [id, words, extensions] of [
    ['hlsl', HLSL, ['.hlsl', '.hlsli', '.fx', '.fxh', '.slang', '.usf', '.ush']],
    ['glsl', GLSL, ['.glsl', '.vert', '.frag', '.geom', '.comp', '.tesc', '.tese']]
  ] as const) {
    if (monaco.languages.getLanguages().some((l) => l.id === id)) continue
    monaco.languages.register({ id, extensions: [...extensions] })
    monaco.languages.setMonarchTokensProvider(id, tokenizer(words))
    monaco.languages.setLanguageConfiguration(id, configuration)
  }
}
