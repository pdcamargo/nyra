import React, { useEffect, useCallback } from 'react'
import Modal from './Modal'
import { RELEASE_NOTES } from '../data/releaseNotes'

export default function ReleaseNotesModal({ onClose }: { onClose: () => void }): React.JSX.Element {
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
    <Modal onClose={onClose} title="Release notes" className="max-w-md max-h-[75vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/55">
          <h2 className="text-sm font-semibold text-foreground">Release Notes</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground/80 transition-colors text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Body — hide the 'next' sentinel; only released versions are shown to users */}
        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {RELEASE_NOTES.filter((r) => r.version !== 'next').map((release, i, arr) => (
            <div key={release.version}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-sm font-semibold font-mono ${i === 0 ? 'text-info' : 'text-foreground/80'}`}>
                  v{release.version}
                </span>
                {i === 0 && (
                  <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-info/20 text-info">
                    latest
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground font-mono">{release.date}</span>
              </div>
              <ul className="space-y-1">
                {release.notes.map((note, j) => (
                  <li key={j} className="flex items-start gap-2 text-[11px] text-foreground/80">
                    <span className="text-muted-foreground mt-0.5 shrink-0">-</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
              {i < arr.length - 1 && (
                <div className="border-t border-border/55 mt-4" />
              )}
            </div>
          ))}
        </div>
      </Modal>
  )
}
