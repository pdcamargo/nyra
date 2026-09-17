import React, { useState, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { HighlighterGeneric } from 'shiki'
import { useFilePreviewStore } from '../store/filePreview'
import { useSettingsStore } from '../store/settings'
import { Check, Copy, WrapText } from 'lucide-react'
import { useResolvedTheme } from '../hooks/useResolvedTheme'
import { useSessionsStore, activeCwd } from '../store/sessions'
import { resolvePath } from '../utils/paths'
import { cachedImage, loadImage, type ImageEntry } from '../lib/imageCache'

const THEME_DARK = 'github-dark-dimmed'
const THEME_LIGHT = 'github-light-default'
// Background colors baked into each Shiki theme — replaced with transparent so
// the surrounding code-block surface shows through.
const THEME_BG: Record<string, string> = {
  [THEME_DARK]: '#22272e',
  [THEME_LIGHT]: '#ffffff'
}

// Load only the most common languages initially (~1 MB vs ~3.8 MB)
const INITIAL_LANGS = ['typescript', 'javascript', 'tsx', 'jsx', 'json', 'bash', 'markdown', 'text', 'diff']
const DEFERRED_LANGS = ['python', 'sh', 'shell', 'jsonc', 'yaml', 'toml', 'css', 'html', 'rust', 'go', 'java', 'c', 'cpp', 'sql', 'regex']
const ALL_LANGS = [...INITIAL_LANGS, ...DEFERRED_LANGS]
const deferredSet = new Set(DEFERRED_LANGS)

// Dynamically import shiki on first use so its grammars/engine stay out of the
// initial bundle — the app shell paints without paying for the highlighter.
let highlighterPromise: Promise<HighlighterGeneric<string, string>> | null = null
function getHighlighter(): Promise<HighlighterGeneric<string, string>> {
  // getSingletonHighlighter narrows to its bundled lang/theme unions; we load
  // languages dynamically, so widen back to the generic string form.
  const pending =
    highlighterPromise ??
    (import('shiki').then(({ getSingletonHighlighter, createJavaScriptRegexEngine }) =>
      getSingletonHighlighter({
        themes: [THEME_DARK, THEME_LIGHT],
        langs: INITIAL_LANGS,
        engine: createJavaScriptRegexEngine()
      })
    ) as Promise<HighlighterGeneric<string, string>>)
  highlighterPromise = pending
  return pending
}

// Load deferred languages on first use
const loadedLangs = new Set(INITIAL_LANGS)
async function ensureLang(highlighter: HighlighterGeneric<string, string>, lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return
  if (deferredSet.has(lang)) {
    await highlighter.loadLanguage(lang as Parameters<typeof highlighter.loadLanguage>[0])
    loadedLangs.add(lang)
  }
}

const CodeBlock = React.memo(function CodeBlock({ language, code }: { language: string; code: string }): React.JSX.Element {
  const [html, setHtml] = useState('')
  const [copied, setCopied] = useState(false)
  // Per block, not per app: whether a snippet is better wrapped or scrolled
  // depends on the snippet — a long shell command wants wrapping, a table of
  // output wants its columns kept.
  const [wrapped, setWrapped] = useState(false)
  const resolvedTheme = useResolvedTheme()
  const shikiTheme = resolvedTheme === 'light' ? THEME_LIGHT : THEME_DARK

  useEffect(() => {
    const lang = ALL_LANGS.includes(language) ? language : 'text'
    getHighlighter().then(async (h) => {
      await ensureLang(h, lang)
      setHtml(
        h.codeToHtml(code, {
          lang,
          theme: shikiTheme,
          colorReplacements: { [THEME_BG[shikiTheme]]: 'transparent' }
        })
      )
    })
  }, [code, language, shikiTheme])

  const handleCopy = (): void => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`my-3 rounded-lg overflow-hidden border border-border bg-muted`}>
      <div className="flex items-center justify-between border-b border-border/55 bg-muted/40 py-1 pl-3 pr-2">
        <span className="text-[10px] text-muted-foreground/70 font-mono">{language || 'code'}</span>
        {/* Icon-only, and the separation comes from each button's own padding
            rather than a gap — the hit target and the spacing are then the same
            thing, so they cannot drift apart. */}
        <div className="-mr-1.5 flex items-center">
          <button
            onClick={() => setWrapped((w) => !w)}
            aria-pressed={wrapped}
            title={wrapped ? 'Stop wrapping — scroll long lines' : 'Wrap long lines'}
            aria-label={wrapped ? 'Stop wrapping long lines' : 'Wrap long lines'}
            className={`rounded-md p-1.5 transition-colors hover:bg-accent/50 ${
              wrapped ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <WrapText className="size-3.5" />
          </button>
          <button
            onClick={handleCopy}
            title={copied ? 'Copied' : 'Copy code'}
            aria-label={copied ? 'Copied' : 'Copy code'}
            className={`rounded-md p-1.5 transition-colors hover:bg-accent/50 ${
              copied ? 'text-success' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      </div>
      {html ? (
        <div
          className={`[&>pre]:m-0 [&>pre]:p-4 [&>pre]:text-[13px] [&>pre]:leading-relaxed [&_code]:bg-transparent [&_code]:p-0 ${
            wrapped
              ? '[&>pre]:whitespace-pre-wrap [&>pre]:break-words [&_code]:whitespace-pre-wrap'
              : '[&>pre]:overflow-x-auto'
          }`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          className={`m-0 p-4 text-[13px] leading-relaxed ${
            wrapped ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto'
          }`}
        >
          <code className="text-foreground/80 font-mono">{code}</code>
        </pre>
      )}
    </div>
  )
})

const remarkPlugins = [remarkGfm]

// Matches file paths: must contain /, end with .ext, no spaces
const FILE_PATH_RE = /^\.{0,2}\/\S+\.\w+$/

function isFilePath(text: string): boolean {
  return FILE_PATH_RE.test(text)
}

// PNG and JPEG only, matching what `fs_read_image` will hand back. Checked here
// as well so an obvious non-image never becomes an IPC call at all.
const RENDERABLE_IMAGE_RE = /\.(png|jpe?g)$/i

// Anything carrying a scheme. In practice only http(s) reaches us: react-markdown's
// default urlTransform blanks `data:` and `file:` before the component sees them.
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/**
 * An image Claude referenced with ordinary markdown, `![alt](/abs/path.png)`.
 *
 * Everything here fails closed, because the src is a string Claude typed and the
 * convention that produces it gets followed unevenly — expect it on prose that
 * did not need it, and absent where it would have helped. A bad src should read
 * as plain text, never as a broken-image icon.
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }): React.JSX.Element {
  const cwd = useSessionsStore(activeCwd)
  const label = alt || 'image'

  const resolved = useMemo(() => {
    if (!src || HAS_SCHEME_RE.test(src)) return null
    // A relative path only means something beside the dir the chat runs in, and
    // MarkdownRenderer also draws plan cards and the memory preview, where there
    // may be no session to resolve against.
    if (!src.startsWith('/') && !cwd) return null
    const full = resolvePath(src, cwd)
    return RENDERABLE_IMAGE_RE.test(full.split(/[?#]/)[0]) ? full : null
  }, [src, cwd])

  const [entry, setEntry] = useState<ImageEntry | undefined>(() =>
    resolved ? cachedImage(resolved) : undefined
  )

  useEffect(() => {
    if (!resolved) return
    const hit = cachedImage(resolved)
    if (hit) {
      setEntry(hit)
      return
    }
    setEntry(undefined)
    let alive = true
    void loadImage(resolved).then((next) => {
      if (alive) setEntry(next)
    })
    return () => {
      alive = false
    }
  }, [resolved])

  // A remote image cannot render: the CSP allows `data:` and `blob:` but not
  // `https:`, and widening it would let a README Claude quotes phone home. The
  // link is the honest fallback.
  if (src && HAS_SCHEME_RE.test(src)) {
    return (
      <a href={src} className="text-info/80 hover:text-info underline underline-offset-2 transition-colors" target="_blank" rel="noreferrer">
        {label}
      </a>
    )
  }

  // Not a path we will read — wrong extension, or relative with no cwd.
  if (!resolved) return <span className="text-muted-foreground">{label}</span>

  if (entry?.status === 'ready') {
    return (
      <img
        src={entry.dataUrl}
        alt={label}
        title={resolved}
        className="my-1 max-h-[32rem] max-w-full h-auto w-auto rounded-lg border border-border/55"
      />
    )
  }

  if (entry?.status === 'error') {
    return (
      <span className="my-1 inline-block rounded-lg border border-border/55 bg-muted px-3 py-2 text-xs text-muted-foreground">
        {label} — {entry.message}
      </span>
    )
  }

  // Reserve some height so the virtualiser's re-measure when bytes land nudges
  // the row rather than snapping it. Inline-block on purpose: a standalone
  // `![...]` lands inside a `<p>`, which a block element would break out of.
  return <span className="my-1 inline-block h-32 w-48 animate-pulse rounded-lg border border-border/55 bg-muted" />
}

function MarkdownRendererInner({ children }: { children: string }): React.JSX.Element {

  const components = useMemo(() => ({
    pre({ children }: { children: React.ReactNode }) {
      return <>{children}</>
    },
    code({ className, children, ...props }: { className?: string; children: React.ReactNode }) {
      const match = /language-(\w+)/.exec(className || '')
      const code = String(children).replace(/\n$/, '')
      const isBlock = !!className || code.includes('\n')

      if (!isBlock) {
        const text = String(children)
        if (isFilePath(text)) {
          return (
            <code
              className="rounded-sm bg-accent px-1.5 py-0.5 text-[0.85em] font-mono text-info/70 hover:text-info cursor-pointer transition-colors"
              onClick={() => useFilePreviewStore.getState().open(text)}
              {...props}
            >
              {children}
            </code>
          )
        }
        return (
          <code className="rounded-sm bg-accent px-1.5 py-0.5 text-[0.85em] font-mono text-foreground" {...props}>
            {children}
          </code>
        )
      }

      return <CodeBlock language={match?.[1] ?? ''} code={code} />
    },
    h1({ children }: { children: React.ReactNode }) {
      return <h1 className={`text-xl font-bold text-foreground first:mt-0 mt-5 mb-2`}>{children}</h1>
    },
    h2({ children }: { children: React.ReactNode }) {
      return <h2 className={`text-base font-semibold text-foreground first:mt-0 mt-4 mb-2`}>{children}</h2>
    },
    h3({ children }: { children: React.ReactNode }) {
      return <h3 className={`text-sm font-semibold text-foreground first:mt-0 mt-3 mb-1`}>{children}</h3>
    },
    p({ children }: { children: React.ReactNode }) {
      return <p className={`last:mb-0 leading-relaxed mb-3`}>{children}</p>
    },
    strong({ children }: { children: React.ReactNode }) {
      return <strong className="font-semibold text-foreground">{children}</strong>
    },
    em({ children }: { children: React.ReactNode }) {
      return <em className="italic text-foreground/80">{children}</em>
    },
    ul({ children }: { children: React.ReactNode }) {
      return <ul className={`ml-4 list-disc last:mb-0 mb-3 space-y-1`}>{children}</ul>
    },
    ol({ children }: { children: React.ReactNode }) {
      return <ol className={`ml-4 list-decimal last:mb-0 mb-3 space-y-1`}>{children}</ol>
    },
    li({ children }: { children: React.ReactNode }) {
      return <li className="text-foreground leading-relaxed">{children}</li>
    },
    blockquote({ children }: { children: React.ReactNode }) {
      return <blockquote className={`border-l-2 border-border-strong pl-3 italic text-muted-foreground my-3`}>{children}</blockquote>
    },
    a({ href, children }: { href?: string; children: React.ReactNode }) {
      return <a href={href} className="text-info/80 hover:text-info underline underline-offset-2 transition-colors" target="_blank" rel="noreferrer">{children}</a>
    },
    img({ src, alt }: { src?: string; alt?: string }) {
      return <MarkdownImage src={src} alt={alt} />
    },
    hr() { return <hr className="border-border-strong my-4" /> },
    table({ children }: { children: React.ReactNode }) {
      return <div className="my-3 overflow-x-auto"><table className="w-full text-sm border-collapse">{children}</table></div>
    },
    thead({ children }: { children: React.ReactNode }) {
      return <thead className="border-b border-border-strong">{children}</thead>
    },
    th({ children }: { children: React.ReactNode }) {
      return <th className="text-left py-1.5 px-3 text-foreground/80 font-medium text-xs uppercase tracking-wide">{children}</th>
    },
    td({ children }: { children: React.ReactNode }) {
      return <td className="py-1.5 px-3 border-b border-border/55 text-foreground/80">{children}</td>
    }
  }), [])

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components as Components}>
      {children}
    </ReactMarkdown>
  )
}

const MarkdownRenderer = React.memo(MarkdownRendererInner)
export default MarkdownRenderer
