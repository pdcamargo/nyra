import React, { useState, useEffect, useCallback } from 'react'
import Modal from './Modal'
import { Editor } from '@monaco-editor/react'
import { installMonacoEnvironment } from '../lib/monacoEnv'
import { useSkillEditorStore } from '../store/skillEditor'
import { useSessionsStore, activeProjectCwd } from '../store/sessions'
import { homedir } from '../lib/homedir'
import { useMonacoNyraTheme } from '../hooks/useMonacoNyraTheme'

installMonacoEnvironment()

const TEMPLATE = '# Skill Name\n\nInstructions for Claude when this skill is invoked...\n'

function parseFrontmatter(raw: string): { description: string; extraFields: string[]; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { description: '', extraFields: [], body: raw }
  const yaml = match[1]
  const body = match[2]
  const descMatch = yaml.match(/^description:\s*(.+)$/m)
  const extraFields = yaml
    .split('\n')
    .filter((l) => l.trim() && !l.match(/^(name|description):\s/))
  return { description: descMatch ? descMatch[1].trim() : '', extraFields, body }
}

function buildFrontmatter(
  skillName: string,
  description: string,
  extraFields: string[],
  body: string
): string {
  const lines = ['---', `name: ${skillName}`]
  if (description.trim()) lines.push(`description: ${description.trim()}`)
  lines.push(...extraFields)
  lines.push('---', '')
  return lines.join('\n') + body
}

export default function SkillEditorModal(): React.JSX.Element | null {
  const { isOpen, mode, skillName, skillScope, filePath, close } = useSkillEditorStore()
  const { defined: themeDefined, theme } = useMonacoNyraTheme()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [extraFields, setExtraFields] = useState<string[]>([])
  const [scope, setScope] = useState<'global' | 'project'>('project')
  const [content, setContent] = useState(TEMPLATE)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  // Skills belong to the project, not to a chat's worktree.
  const projectCwd = useSessionsStore(activeProjectCwd)
  const cwd = projectCwd || homedir()

  // Reset state when modal opens
  useEffect(() => {
    if (!isOpen) return
    setError(null)
    setSaving(false)

    if (mode === 'create') {
      setName('')
      setDescription('')
      setExtraFields([])
      setScope(skillScope)
      setContent(TEMPLATE)
    } else {
      setName(skillName)
      setScope(skillScope)
      if (filePath) {
        setLoading(true)
        window.api.fs
          .readFile(filePath)
          .then((res) => {
            if (res.error) {
              setError(res.error)
            } else {
              const raw = res.content ?? ''
              const parsed = parseFrontmatter(raw)
              setDescription(parsed.description)
              setExtraFields(parsed.extraFields)
              setContent(parsed.body)
            }
          })
          .catch((err: Error) => setError(err.message))
          .finally(() => setLoading(false))
      }
    }
  }, [isOpen, mode, skillName, skillScope, filePath])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    },
    [close]
  )

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  const handleSave = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Skill name is required.')
      return
    }
    if (/[^a-zA-Z0-9_-]/.test(trimmedName)) {
      setError('Name can only contain letters, numbers, hyphens, and underscores.')
      return
    }
    if (!content.trim()) {
      setError('Skill content cannot be empty.')
      return
    }

    setSaving(true)
    setError(null)
    const fullContent = buildFrontmatter(trimmedName, description, extraFields, content)
    const result = await window.api.skills.write(scope, trimmedName, fullContent, cwd)
    setSaving(false)

    if (result.error) {
      setError(result.error)
    } else {
      window.dispatchEvent(new Event('nyra:skills-changed'))
      close()
    }
  }

  if (!isOpen) return null

  return (
    <Modal
      onClose={close}
      title="Edit skill"
      className="w-[90vw] max-w-3xl flex flex-col max-h-none h-[75vh]"
    >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/40 border-b border-border/55 shrink-0">
          <span className="text-sm font-medium text-foreground">
            {mode === 'create' ? 'New Skill' : `Edit /${skillName}`}
          </span>
          <button
            onClick={close}
            className="ml-auto text-muted-foreground hover:text-foreground/80 transition-colors text-lg leading-none px-1"
          >
            &times;
          </button>
        </div>

        {/* Name + Scope */}
        <div className="px-4 py-3 border-b border-border/55 shrink-0 space-y-3">
          {/* Name input */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Name
            </label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">/</span>
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))
                  setError(null)
                }}
                disabled={mode === 'edit'}
                placeholder="my-skill"
                className="flex-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm text-foreground placeholder-muted-foreground/70 outline-hidden focus:border-border-strong disabled:opacity-50 disabled:cursor-not-allowed"
                autoFocus
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this skill does and when to use it"
              className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm text-foreground placeholder-muted-foreground/70 outline-hidden focus:border-border-strong"
            />
          </div>

          {/* Scope selector — create mode only */}
          {mode === 'create' && (
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Scope
              </label>
              <div className="flex gap-1">
                {(['project', 'global'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setScope(s)}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium capitalize transition-colors ${
                      scope === s
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:text-foreground/80 hover:bg-accent/50 border border-border/55'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                {scope === 'project'
                  ? 'Saved to .claude/skills/ in your project'
                  : 'Saved to ~/.claude/skills/ (available everywhere)'}
              </p>
            </div>
          )}
        </div>

        {/* Monaco Editor */}
        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Loading...
            </div>
          ) : (
            themeDefined && (
              <Editor
                value={content}
                onChange={(v) => setContent(v ?? '')}
                language="markdown"
                theme={theme}
                options={{
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 13,
                  lineNumbers: 'on',
                  folding: true,
                  glyphMargin: false,
                  lineDecorationsWidth: 0,
                  lineNumbersMinChars: 4,
                  overviewRulerBorder: false,
                  wordWrap: 'on',
                  scrollbar: {
                    vertical: 'auto',
                    horizontal: 'auto',
                    verticalScrollbarSize: 6,
                    horizontalScrollbarSize: 6
                  }
                }}
              />
            )
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-t border-border/55 shrink-0">
          <span className="text-xs text-danger/80 truncate max-w-[60%]">
            {error ?? ''}
          </span>
          <div className="flex gap-2">
            <button
              onClick={close}
              className="rounded-md px-3 py-1.5 text-xs text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-info/90 hover:bg-info px-4 py-1.5 text-xs font-medium text-info-foreground transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
    </Modal>
  )
}
