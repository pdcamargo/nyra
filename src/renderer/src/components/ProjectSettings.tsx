import React, { useEffect, useRef, useState } from 'react'
import { Folder, FolderOpen, Plus, Slash } from 'lucide-react'
import { useSessionsStore, type Project, type ProjectAppearance } from '../store/sessions'
import {
  PROJECT_ICONS,
  PROJECT_TINTS,
  isCustomTint,
  projectIcon,
  tintColor
} from '../lib/project-appearance'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { readRepoScripts, REPO_SCRIPTS_FILE } from '../lib/projectScripts'
import ProjectFolders from './ProjectFolders'
import { Toggle } from './settings/primitives'
import { useSettingsStore } from '../store/settings'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const TINT_LABELS: Record<string, string> = {
  blue: 'Blue',
  green: 'Green',
  amber: 'Amber',
  red: 'Red',
  violet: 'Violet'
}

const ICON_LABELS: Record<string, string> = {
  folder: 'Folder',
  code: 'Code',
  globe: 'Globe',
  box: 'Box',
  rocket: 'Rocket',
  flask: 'Flask',
  book: 'Book',
  gamepad: 'Gamepad',
  palette: 'Palette',
  terminal: 'Terminal',
  server: 'Server',
  phone: 'Phone',
  database: 'Database',
  bot: 'Bot',
  music: 'Music',
  briefcase: 'Briefcase'
}

/** Seeded into the system colour picker when nothing custom has been chosen. */
const CUSTOM_SEED = '#b45309'

/**
 * A project's name, folders and look, opened from Settings… in its menu.
 *
 * Every change applies as it is made — there is no Save. The name is the one
 * exception to "as it is made": an empty one is not committed, and blurring the
 * field puts the old name back.
 */
export default function ProjectSettings({ project }: { project: Project }): React.JSX.Element {
  const [name, setName] = useState(project.name)
  const colorInput = useRef<HTMLInputElement>(null)
  const store = useSessionsStore.getState
  const set = (patch: ProjectAppearance): void => store().setProjectAppearance(project.id, patch)
  const spine = useSettingsStore((s) => s.sidebarStyle === 'spine')

  const tint = tintColor(project.color)
  const custom = isCustomTint(project.color) ? project.color : null
  const TileIcon = projectIcon(project.icon) ?? FolderOpen

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${tint ? 'project-wash' : 'bg-muted'}`}
          style={tint ? ({ '--project-tint': tint } as React.CSSProperties) : undefined}
        >
          <TileIcon
            className={`size-4 ${tint ? '' : 'text-muted-foreground'}`}
            style={tint ? { color: tint } : undefined}
          />
        </span>
        <Input
          aria-label="Project name"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (e.target.value.trim()) store().renameProject(project.id, e.target.value)
          }}
          onBlur={() => setName(useSessionsStore.getState().projects.find((p) => p.id === project.id)?.name ?? name)}
          onKeyDown={(e) => {
            // The sidebar's own shortcuts must not fire while typing a name.
            e.stopPropagation()
          }}
          className="h-8"
        />
      </div>

      <Divider />

      <ProjectFolders project={project} />

      <Divider />

      {(project.statusAccess?.length ?? 0) > 0 && (
        <>
          <StatusAccess project={project} />
          <Divider />
        </>
      )}

      <SectionLabel>Icon</SectionLabel>
      <div className="grid grid-cols-8 gap-1">
        {Object.entries(PROJECT_ICONS).map(([key, Icon]) => {
          // The folder is the default, and choosing it clears the field.
          const selected = (project.icon ?? 'folder') === key
          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={ICON_LABELS[key]}
                  aria-pressed={selected}
                  onClick={() => set({ icon: key === 'folder' ? undefined : key })}
                  className={`flex size-[30px] items-center justify-center rounded-md transition-colors ${
                    selected
                      ? 'bg-accent text-foreground ring-1 ring-border-strong'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                  }`}
                >
                  <Icon className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{ICON_LABELS[key]}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      <SectionLabel>Colour</SectionLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        <Swatch label="No colour" selected={!tint} onClick={() => set({ color: undefined })}>
          <span className="flex size-full items-center justify-center rounded-full border border-border bg-background">
            <Slash className="size-3 text-muted-foreground" />
          </span>
        </Swatch>
        {PROJECT_TINTS.map((t) => (
          <Swatch key={t} label={TINT_LABELS[t]} selected={project.color === t} onClick={() => set({ color: t })}>
            <span className="block size-full rounded-full" style={{ background: `var(--tint-${t})` }} />
          </Swatch>
        ))}
        <Swatch
          label={custom ? `Custom colour ${custom}` : 'Custom colour'}
          selected={!!custom}
          onClick={() => colorInput.current?.click()}
        >
          {custom ? (
            <span className="block size-full rounded-full" style={{ background: custom }} />
          ) : (
            <span
              className="flex size-full items-center justify-center rounded-full"
              style={{ background: 'conic-gradient(#ef4444, #f59e0b, #22c55e, #3b82f6, #8b5cf6, #ef4444)' }}
            >
              <Plus className="size-3 text-white" />
            </span>
          )}
        </Swatch>
        {custom && <span className="font-mono text-[0.85em] text-muted-foreground">{custom.toUpperCase()}</span>}
        {/* The system colour panel. WebKit fires input as the user drags in it,
            so the row follows the pick live. */}
        <input
          ref={colorInput}
          type="color"
          tabIndex={-1}
          aria-hidden
          className="sr-only"
          value={custom ?? CUSTOM_SEED}
          onChange={(e) => set({ color: e.target.value.toLowerCase() })}
        />
      </div>

      <div className="py-2">
        <Divider />
      </div>

      <div className="flex flex-col gap-4">
        <ToggleRow
          label="Row background"
          checked={!!project.wash}
          disabled={!tint}
          onChange={(on) => set({ wash: on })}
        />
        {/* The Spine style draws one for every project, coloured or not. */}
        <ToggleRow
          label={spine ? 'Rail down its chats — always, in Spine' : 'Rail down its chats'}
          checked={spine || !!project.rail}
          disabled={spine || !tint}
          onChange={(on) => set({ rail: on })}
        />
      </div>

      <div className="py-2">
        <Divider />
      </div>

      <Scripts project={project} />
    </div>
  )
}

/**
 * Setup, run in each new worktree before Claude starts, and Run, what the
 * title bar's Run button starts. A `.nyra/scripts.json` in the repo wins over
 * both, and is shown here read-only so it is clear why an edit would not take.
 */
function Scripts({ project }: { project: Project }): React.JSX.Element {
  const [repo, setRepo] = useState<Awaited<ReturnType<typeof readRepoScripts>> | undefined>(undefined)
  const [setup, setSetup] = useState(project.scripts?.setup ?? '')
  const [run, setRun] = useState(project.scripts?.run ?? '')
  useEffect(() => {
    let live = true
    void readRepoScripts(project.path).then((r) => live && setRepo(r))
    return () => {
      live = false
    }
  }, [project.path])
  const save = (patch: { setup?: string; run?: string }): void =>
    useSessionsStore.getState().setProjectScripts(project.id, patch)
  const fromRepo = !!repo

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Scripts</SectionLabel>
        <span className="pt-1 text-[0.8em] text-muted-foreground">
          {fromRepo ? (
            <>
              From <code className="font-mono">{REPO_SCRIPTS_FILE}</code>
            </>
          ) : (
            'Saved in Nyra, not the repo'
          )}
        </span>
      </div>
      <ScriptField
        label="Setup"
        hint="Runs in each new worktree before Claude starts."
        value={fromRepo ? (repo.setup ?? '') : setup}
        readOnly={fromRepo}
        multiline
        placeholder={'npm install\ncp $NYRA_ROOT_PATH/.env .env'}
        onChange={(v) => {
          setSetup(v)
          save({ setup: v })
        }}
      />
      <ScriptField
        label="Run"
        hint="What the Run button starts, in the chat’s folder."
        value={fromRepo ? (repo.run ?? '') : run}
        readOnly={fromRepo}
        placeholder="npm run dev"
        onChange={(v) => {
          setRun(v)
          save({ run: v })
        }}
      />
      <p className="text-[0.8em] text-muted-foreground">
        {fromRepo ? (
          'Edit the file to change them; it is shared with everyone who clones the repo.'
        ) : (
          <>
            <code className="font-mono">$NYRA_ROOT_PATH</code> is the project’s own folder, so setup can copy files
            git doesn’t track.
          </>
        )}
      </p>
    </div>
  )
}

function ScriptField({
  label,
  hint,
  value,
  readOnly,
  multiline,
  placeholder,
  onChange
}: {
  label: string
  hint: string
  value: string
  readOnly: boolean
  multiline?: boolean
  placeholder: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const common = {
    'aria-label': `${label} script`,
    value,
    readOnly,
    placeholder: readOnly ? 'Not set' : placeholder,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    // The sidebar's own shortcuts must not fire while typing a script.
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    className: `font-mono text-[0.85em] ${readOnly ? 'bg-muted/40' : ''}`
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col">
        <span className="text-[0.92em] font-medium text-foreground">{label}</span>
        <span className="text-[0.8em] text-muted-foreground">{hint}</span>
      </div>
      {multiline ? <Textarea rows={2} {...common} className={`min-h-0 ${common.className}`} /> : <Input {...common} className={`h-8 ${common.className}`} />}
    </div>
  )
}

function Divider(): React.JSX.Element {
  return <div className="h-px bg-border" />
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="pt-1 text-[0.85em] text-muted-foreground">{children}</p>
}

/**
 * The projects this one's chats may see the status of — what was answered
 * "Always" when Claude asked. Only there once something has been, and
 * revoking is the whole of what there is to do with it.
 */
function StatusAccess({ project }: { project: Project }): React.JSX.Element {
  const projects = useSessionsStore((s) => s.projects)
  const access = project.statusAccess ?? []
  const revoke = (key: string): void =>
    useSessionsStore.getState().setProjectStatusAccess(
      project.id,
      access.filter((a) => a.projectId !== key)
    )
  return (
    <div className="flex flex-col gap-1">
      <p className="px-1 pt-1 text-[0.85em] text-muted-foreground">Chats here can see what’s running in</p>
      {access.map((a) => (
        <div key={a.projectId} className="flex items-center gap-2 rounded-md px-1 py-0.5">
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[0.92em] text-foreground">
            {a.projectId ? (projects.find((p) => p.id === a.projectId)?.name ?? 'A removed project') : 'Chats outside any project'}
          </span>
          <button
            type="button"
            onClick={() => revoke(a.projectId)}
            className="shrink-0 text-[0.92em] font-medium text-info hover:underline"
          >
            Revoke
          </button>
        </div>
      ))}
      <p className="px-1 text-[0.8em] text-muted-foreground">Titles and states only, never messages.</p>
    </div>
  )
}

function Swatch({
  label,
  selected,
  onClick,
  children
}: {
  label: string
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={selected}
          onClick={onClick}
          className={`size-6 rounded-full border-2 p-[2px] transition-colors ${
            selected ? 'border-foreground' : 'border-transparent hover:border-border-strong'
          }`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ToggleRow({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  return (
    // Without a colour there is nothing for either to draw, so both wait for one.
    <label className={`flex items-center gap-2.5 ${disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}>
      <Toggle checked={checked} onChange={onChange} />
      <span className="text-[0.92em] text-foreground">{label}</span>
    </label>
  )
}
