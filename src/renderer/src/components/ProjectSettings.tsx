import React, { useRef, useState } from 'react'
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
import { Toggle } from './settings/primitives'
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
 * A project's name, folder and look, opened from Settings… in its menu.
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

      <div className="flex items-center gap-2 px-1">
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.85em] text-muted-foreground" title={project.path}>
          {project.path}
        </span>
        <button
          type="button"
          className="shrink-0 text-[0.92em] font-medium text-info hover:underline"
          onClick={() =>
            void window.api.dialog.pickFolder().then((folder) => {
              if (folder) store().setProjectPath(project.id, folder)
            })
          }
        >
          Change…
        </button>
      </div>

      <Divider />

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
        <ToggleRow
          label="Rail down its chats"
          checked={!!project.rail}
          disabled={!tint}
          onChange={(on) => set({ rail: on })}
        />
      </div>
    </div>
  )
}

function Divider(): React.JSX.Element {
  return <div className="h-px bg-border" />
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="pt-1 text-[0.85em] text-muted-foreground">{children}</p>
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
