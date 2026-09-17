import React, { useMemo, useState, useEffect, useCallback } from 'react'
import Modal from './Modal'
import { useSessionsStore, type TextMessage } from '../store/sessions'

type ExtractedBlock = {
  index: number
  lang: string
  code: string
  preview: string
}

const CODE_BLOCK_RE = /^```(\w*)\n([\s\S]*?)^```/gm

function extractCodeBlocks(messages: ReturnType<typeof useSessionsStore.getState>['sessions'][0]['messages']): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  let blockIndex = 0
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const text = (msg as TextMessage).text
    if (!text) continue
    CODE_BLOCK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CODE_BLOCK_RE.exec(text)) !== null) {
      const lang = m[1] || 'text'
      const code = m[2].trimEnd()
      const preview = code.split('\n').slice(0, 2).join('\n')
      blocks.push({ index: ++blockIndex, lang, code, preview })
    }
  }
  return blocks
}

export default function CopyBlocksModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const messages = useSessionsStore((s) => {
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId)
    return session?.messages ?? []
  })
  const blocks = useMemo(() => extractCodeBlocks(messages), [messages])
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const handleCopy = (block: ExtractedBlock): void => {
    navigator.clipboard.writeText(block.code)
    setCopiedIndex(block.index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Modal onClose={onClose} title="Copy code blocks" className="max-w-2xl max-h-[70vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/55">
          <h2 className="text-sm font-semibold text-foreground">Code Blocks</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground/80 transition-colors text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        {blocks.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">No code blocks found in this session.</div>
        ) : (
          <div className="overflow-y-auto flex-1 divide-y divide-border/55">
            {blocks.map((block) => (
              <div key={block.index} className="flex items-start gap-3 px-5 py-3 hover:bg-muted/40 transition-colors">
                <span className="mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wide bg-accent text-muted-foreground min-w-[42px] text-center">
                  {block.lang}
                </span>
                <pre className="flex-1 font-mono text-[11px] text-foreground/80 whitespace-pre-wrap leading-relaxed overflow-hidden" style={{ maxHeight: '2.6rem' }}>
                  {block.preview}
                </pre>
                <button
                  onClick={() => handleCopy(block)}
                  className={`shrink-0 rounded px-2.5 py-1 text-[11px] font-medium border transition-colors mt-0.5 ${
                    copiedIndex === block.index
                      ? 'border-success/30 text-success/80 bg-success/10'
                      : 'border-border text-muted-foreground hover:text-foreground hover:border-border-strong'
                  }`}
                >
                  {copiedIndex === block.index ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ))}
          </div>
        )}
      </Modal>
  )
}
