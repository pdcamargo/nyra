import { useEffect } from 'react'
import { useSessionsStore, createSiblingSession } from '../store/sessions'
import { useWorkflowStore } from '../store/workflow'
import { useUiStore } from '../store/ui'

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.metaKey) {
        // Cmd+F — Toggle in-session search (find in conversation)
        if (e.key === 'f' && !e.shiftKey) {
          e.preventDefault()
          window.dispatchEvent(new Event('nyra:toggle-insession-search'))
          return
        }

        // Cmd+K — Command palette. This used to clear the conversation, which is
        // a destructive action on the one binding every app uses for a palette.
        // Clearing is still a palette action, and still /clear.
        if (e.key === 'k' && !e.shiftKey) {
          e.preventDefault()
          useUiStore.getState().openPalette('all')
          return
        }

        // Cmd+Shift+F — the palette's old binding, kept for muscle memory
        if (e.key === 'f' && e.shiftKey) {
          e.preventDefault()
          useUiStore.getState().openPalette('all')
          return
        }

        // Cmd+Shift+B — Toggle the browser. Codex binds the same keys to the
        // same thing; muscle memory is worth more here than originality.
        if (e.key.toLowerCase() === 'b' && e.shiftKey) {
          e.preventDefault()
          useUiStore.getState().toggleBrowserPanel()
          return
        }

        // Cmd+N — New session
        if (e.key === 'n') {
          e.preventDefault()
          createSiblingSession()
          return
        }

        // Cmd+Shift+W — Toggle workflow canvas
        if (e.key === 'w' && e.shiftKey) {
          e.preventDefault()
          const { isCanvasOpen, openCanvas, closeCanvas } = useWorkflowStore.getState()
          if (isCanvasOpen) closeCanvas()
          else openCanvas()
          return
        }

        // Cmd+[ — Previous session
        if (e.key === '[') {
          e.preventDefault()
          const { sessions, activeSessionId, setActiveSession } = useSessionsStore.getState()
          if (sessions.length < 2 || !activeSessionId) return
          const currentIndex = sessions.findIndex((s) => s.id === activeSessionId)
          if (currentIndex === -1) return
          const prevIndex = (currentIndex - 1 + sessions.length) % sessions.length
          setActiveSession(sessions[prevIndex].id)
          return
        }

        // Cmd+] — Next session
        if (e.key === ']') {
          e.preventDefault()
          const { sessions, activeSessionId, setActiveSession } = useSessionsStore.getState()
          if (sessions.length < 2 || !activeSessionId) return
          const currentIndex = sessions.findIndex((s) => s.id === activeSessionId)
          if (currentIndex === -1) return
          const nextIndex = (currentIndex + 1) % sessions.length
          setActiveSession(sessions[nextIndex].id)
          return
        }
      }

      // Escape — Abort running Claude process for the active session
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        window.api.claude.abort(useSessionsStore.getState().activeSessionId ?? undefined)
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
