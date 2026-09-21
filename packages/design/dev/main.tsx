import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { compile, renderArtboard } from '../src/pipeline'
import type { Issue } from '../src/pipeline/types'

const files = import.meta.glob('../examples/*.nyui.json', { eager: true }) as Record<
  string,
  { default: unknown }
>

const named = Object.entries(files)
  .map(([path, mod]) => ({ name: path.split('/').pop()!.replace('.nyui.json', ''), doc: mod.default }))
  .sort((a, b) => a.name.localeCompare(b.name))

const ui = {
  font: '13px ui-sans-serif, system-ui, sans-serif',
  border: '1px solid #E7E7EC'
}

function IssueList({ issues }: { issues: Issue[] }): React.ReactElement | null {
  if (issues.length === 0) return null
  return (
    <ul style={{ margin: '8px 0 0', padding: '0 0 0 18px', font: ui.font, color: '#71727F' }}>
      {issues.map((i, n) => (
        <li key={n} style={{ color: i.severity === 'error' ? '#DC2626' : '#B45309' }}>
          <code>{i.code}</code> {i.message}
          {i.at ? ` — ${i.at.scope}#${i.at.id}` : ''}
        </li>
      ))}
    </ul>
  )
}

function Design({ name, doc }: { name: string; doc: unknown }): React.ReactElement {
  const result = useMemo(() => {
    try {
      return { ok: true as const, ...compile(doc) }
    } catch (e) {
      const issues = (e as { issues?: Issue[] }).issues ?? []
      return { ok: false as const, error: (e as Error).message, issues }
    }
  }, [doc])

  return (
    <section style={{ marginBottom: 48 }}>
      <h2 style={{ font: ui.font, fontWeight: 600, margin: '0 0 8px' }}>{name}</h2>
      {result.ok ? (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {result.doc.artboards.map((a) => (
              <figure key={a.id} style={{ margin: 0 }}>
                <figcaption style={{ font: ui.font, color: '#71727F', marginBottom: 6 }}>
                  {a.name} · {a.size.width}×{a.size.height}
                </figcaption>
                <div style={{ border: ui.border, width: 'fit-content' }}>
                  {renderArtboard(a, result.theme)}
                </div>
              </figure>
            ))}
          </div>
          <IssueList issues={result.issues} />
        </>
      ) : (
        <>
          <pre style={{ font: ui.font, color: '#DC2626', whiteSpace: 'pre-wrap' }}>{result.error}</pre>
          <IssueList issues={result.issues} />
        </>
      )}
    </section>
  )
}

function App(): React.ReactElement {
  const [only, setOnly] = useState<string>('')
  const shown = only ? named.filter((d) => d.name === only) : named
  return (
    <main style={{ padding: 24, background: '#FFFFFF' }}>
      <div style={{ font: ui.font, marginBottom: 20, display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>@nyra/design</strong>
        <select value={only} onChange={(e) => setOnly(e.target.value)} style={{ font: ui.font }}>
          <option value="">all ({named.length})</option>
          {named.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      {shown.map((d) => (
        <Design key={d.name} name={d.name} doc={d.doc} />
      ))}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
