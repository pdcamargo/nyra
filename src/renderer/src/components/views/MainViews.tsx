import React, { Suspense, useCallback, useEffect, useState } from 'react'
import { Brain, Slash, Sparkles, SquareTerminal } from 'lucide-react'
import { BUILT_IN_COMMANDS } from '../../data/commands'
import { useSkillEditorStore } from '../../store/skillEditor'
import { useSessionsStore, activeProjectCwd } from '../../store/sessions'
import { useUiStore } from '../../store/ui'
import { homedir } from '../../lib/homedir'
import type { BundledSkill, CommandInfo, SkillInfo } from '../../lib/api-types'
import { openFileInPanel } from '../../lib/openFile'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  DialogAction,
  EmptyNote,
  LibraryCard,
  LibraryGrid,
  LibrarySearch,
  PreviewDialog,
  ProjectTabs,
  SectionHeading,
  matches,
  useScopedLibrary
} from './Library'

const MemoryTab = React.lazy(() => import('../MemoryTab'))

/**
 * The shell every page in the main area shares.
 *
 * A measure and a heading, because these are pages now rather than the contents
 * of a 256px rail. The old rail versions had neither: a filter box and a list of
 * rows, with the tab label above them doing the work of a title.
 */
function Page({
  title,
  blurb,
  Icon,
  actions,
  children
}: {
  title: string
  blurb: string
  Icon: React.ComponentType<{ className?: string }>
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="scroll-auto-hide flex-1 overflow-y-scroll">
      <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <header className="mb-6 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[1.6em] font-semibold tracking-tight text-foreground">
              <Icon className="size-5 shrink-0 text-muted-foreground" />
              {title}
            </h1>
            <p className="mt-1 text-c-md text-muted-foreground">{blurb}</p>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  )
}

/** New and Import, which used to be a footer under the rail's skills tab. */
function SkillActions(): React.JSX.Element {
  const importSkill = useCallback(async () => {
    const filePath = await window.api.dialog.pickFile()
    if (!filePath) return
    const { content, error } = await window.api.fs.readFile(filePath)
    if (error || !content) return

    // Frontmatter names the skill when it has any; otherwise the filename does,
    // and `SKILL.md` means the directory above it is the name.
    const fm = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    let name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1].trim() ?? null
    if (!name) {
      const parts = filePath.split('/')
      const fileName = parts[parts.length - 1]
      name =
        fileName.toLowerCase() === 'skill.md'
          ? (parts[parts.length - 2] ?? 'imported-skill')
          : fileName.replace(/\.md$/i, '')
    }
    name =
      name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'imported-skill'

    const cwd = activeProjectCwd(useSessionsStore.getState()) || homedir()
    await window.api.skills.write('project', name, content, cwd)
    window.dispatchEvent(new Event('nyra:skills-changed'))
    // No frontmatter means no description, and a skill without one is invisible
    // to the model. Open it so that can be fixed now rather than discovered.
    if (!fm) {
      useSkillEditorStore
        .getState()
        .openEdit({ name, scope: 'project', filePath: `${cwd}/.claude/skills/${name}/SKILL.md` })
    }
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={() => useSkillEditorStore.getState().openNew()}
        className="rounded-md bg-info/90 px-3 py-1.5 text-c-md font-medium text-info-foreground transition-colors hover:bg-info"
      >
        New skill
      </button>
      <button
        type="button"
        onClick={importSkill}
        className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-c-md font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
      >
        Import
      </button>
    </>
  )
}

/** Marks a skill Nyra installed, and says whether it still updates it. */
function ManagedBadge({ status }: { status: BundledSkill['status'] }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 rounded-[3px] border border-border/70 px-1 py-px text-[0.62em] font-medium uppercase tracking-wide text-muted-foreground">
          {status === 'adopted' ? 'Nyra · yours' : 'Nyra'}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {status === 'adopted'
          ? 'Shipped by Nyra, then edited — so Nyra no longer updates it. Reset it to go back to the current version.'
          : 'Installed by Nyra and kept current. Edit it and it becomes yours — Nyra stops touching it.'}
      </TooltipContent>
    </Tooltip>
  )
}

const listSkills = (cwd: string): Promise<{ global: SkillInfo[]; project: SkillInfo[] }> =>
  window.api.skills.list(cwd)

function SkillsView(): React.JSX.Element {
  const { global, byProject, projects, activeId, setActiveId, reload } = useScopedLibrary(
    listSkills,
    'nyra:skills-changed'
  )
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<SkillInfo | null>(null)
  const [bundled, setBundled] = useState<BundledSkill[]>([])
  const setPendingAction = useSessionsStore((s) => s.setPendingAction)
  const setMainView = useUiStore((s) => s.setMainView)

  useEffect(() => {
    void window.api.skills.bundledNames().then(setBundled)
  }, [])

  const managed = (skill: SkillInfo): BundledSkill['status'] | undefined =>
    skill.scope === 'global' ? bundled.find((b) => b.name === skill.name)?.status : undefined

  const card = (skill: SkillInfo): React.JSX.Element => {
    const status = managed(skill)
    return (
      <LibraryCard
        key={skill.filePath}
        name={`/${skill.name}`}
        description={skill.description}
        Icon={Sparkles}
        badge={status ? <ManagedBadge status={status} /> : undefined}
        onClick={() => setOpen(skill)}
      />
    )
  }

  // Two states leave a Nyra skill off updates, and neither is visible anywhere
  // else: deleted (the backend records it and stops reinstalling) and edited
  // (the backend adopts it and stops writing). Both are one-way doors without
  // an offer to reinstall, and a silently stale skill is a bad surprise.
  const needsAttention = bundled.flatMap((b) => {
    const installed = global.some((s) => s.name === b.name)
    if (!installed) return [{ name: b.name, note: 'is not installed', action: 'Install' }]
    if (b.status === 'adopted')
      return [{ name: b.name, note: 'is edited, so updates stopped', action: 'Reset' }]
    return []
  })

  const globalSkills = matches(global, search)
  const projectSkills = matches(activeId ? (byProject[activeId] ?? []) : [], search)
  const activeProject = projects.find((p) => p.id === activeId)

  return (
    <Page
      title="Skills"
      Icon={Sparkles}
      blurb="Extend Claude with task-specific skills, for this project or for every one."
      actions={<SkillActions />}
    >
      <LibrarySearch value={search} onChange={setSearch} placeholder="Search skills" />

      <section className="mb-8">
        <SectionHeading trailing="~/.claude/skills">Global</SectionHeading>
        {globalSkills.length > 0 ? (
          <LibraryGrid>{globalSkills.map(card)}</LibraryGrid>
        ) : (
          <EmptyNote>{search ? 'Nothing matches here.' : 'No global skills yet.'}</EmptyNote>
        )}
        {!search &&
          needsAttention.map(({ name, note, action }) => (
            <div
              key={name}
              className="mt-1.5 flex items-center justify-between gap-2 rounded-md border border-dashed border-border/55 px-2.5 py-2"
            >
              <span className="truncate text-c-sm text-muted-foreground">
                Nyra&rsquo;s <span className="font-medium text-foreground/80">/{name}</span> {note}
              </span>
              <button
                type="button"
                onClick={async () => {
                  await window.api.skills.restoreBundled(name)
                  window.dispatchEvent(new Event('nyra:skills-changed'))
                  void window.api.skills.bundledNames().then(setBundled)
                }}
                className="shrink-0 text-c-sm text-info transition-colors hover:underline"
              >
                {action}
              </button>
            </div>
          ))}
      </section>

      <section>
        <SectionHeading
          trailing={activeProject ? `${activeProject.path}/.claude/skills` : undefined}
        >
          By project
        </SectionHeading>
        <ProjectTabs projects={projects} activeId={activeId} onSelect={setActiveId} />
        {projects.length === 0 ? (
          <EmptyNote>Add a project and its own skills show up here.</EmptyNote>
        ) : projectSkills.length > 0 ? (
          <LibraryGrid>{projectSkills.map(card)}</LibraryGrid>
        ) : (
          <EmptyNote>
            {search ? 'Nothing matches here.' : 'This project has no skills of its own.'}
          </EmptyNote>
        )}
      </section>

      {open && (
        <PreviewDialog
          open
          onClose={() => setOpen(null)}
          name={`/${open.name}`}
          description={open.description}
          filePath={open.filePath}
          kind="Skill"
          badge={managed(open) ? <ManagedBadge status={managed(open)!} /> : undefined}
          onDelete={async () => {
            await window.api.skills.delete(open.filePath)
            window.dispatchEvent(new Event('nyra:skills-changed'))
            reload()
          }}
          actions={
            <>
              <DialogAction
                onClick={async () => {
                  const { content, error } = await window.api.fs.readFile(open.filePath)
                  if (error || !content) return
                  await window.api.dialog.saveFile(`${open.name}.md`, content)
                }}
              >
                Export
              </DialogAction>
              <DialogAction
                onClick={() => {
                  useSkillEditorStore.getState().openEdit(open)
                  setOpen(null)
                }}
              >
                Edit
              </DialogAction>
              <DialogAction
                primary
                onClick={() => {
                  setPendingAction({ type: 'send', text: `/${open.name}` })
                  setMainView('chat')
                  setOpen(null)
                }}
              >
                Use
              </DialogAction>
            </>
          }
        />
      )}
    </Page>
  )
}

const listCommands = (cwd: string): Promise<{ global: CommandInfo[]; project: CommandInfo[] }> =>
  window.api.commands.list(cwd)

/**
 * Custom slash commands, the two places the CLI reads them from.
 *
 * The tab this replaces listed neither: it was a static reference card for the
 * commands that work in the CLI's own terminal, which is why it earned its
 * place back only once it could show the ones you actually wrote. That
 * reference is still here, under the real thing.
 */
function CommandsView(): React.JSX.Element {
  const { global, byProject, projects, activeId, setActiveId, reload } = useScopedLibrary(
    listCommands,
    'nyra:commands-changed'
  )
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<CommandInfo | null>(null)
  const setPendingAction = useSessionsStore((s) => s.setPendingAction)
  const setMainView = useUiStore((s) => s.setMainView)

  const card = (command: CommandInfo): React.JSX.Element => (
    <LibraryCard
      key={command.filePath}
      name={`/${command.name}`}
      description={command.description}
      Icon={Slash}
      onClick={() => setOpen(command)}
    />
  )

  const globalCommands = matches(global, search)
  const projectCommands = matches(activeId ? (byProject[activeId] ?? []) : [], search)
  const activeProject = projects.find((p) => p.id === activeId)
  // BUILT_IN_COMMANDS keeps the slash in `name`, unlike the two scanned lists.
  const builtIn = matches(
    BUILT_IN_COMMANDS.map((c) => ({ ...c, filePath: c.name })),
    search
  )

  return (
    <Page
      title="Commands"
      Icon={Slash}
      blurb="Slash commands you have written, for this project or for every one."
    >
      <LibrarySearch value={search} onChange={setSearch} placeholder="Search commands" />

      <section className="mb-8">
        <SectionHeading trailing="~/.claude/commands">Global</SectionHeading>
        {globalCommands.length > 0 ? (
          <LibraryGrid>{globalCommands.map(card)}</LibraryGrid>
        ) : (
          <EmptyNote>
            {search ? (
              'Nothing matches here.'
            ) : (
              <>
                Nothing yet. A <span className="font-mono">.md</span> file in that folder becomes a
                slash command everywhere.
              </>
            )}
          </EmptyNote>
        )}
      </section>

      <section className="mb-8">
        <SectionHeading
          trailing={activeProject ? `${activeProject.path}/.claude/commands` : undefined}
        >
          By project
        </SectionHeading>
        <ProjectTabs projects={projects} activeId={activeId} onSelect={setActiveId} />
        {projects.length === 0 ? (
          <EmptyNote>Add a project and its own commands show up here.</EmptyNote>
        ) : projectCommands.length > 0 ? (
          <LibraryGrid>{projectCommands.map(card)}</LibraryGrid>
        ) : (
          <EmptyNote>
            {search ? (
              'Nothing matches here.'
            ) : (
              <>
                Nothing yet. A <span className="font-mono">.md</span> file in that folder becomes a
                slash command in this project.
              </>
            )}
          </EmptyNote>
        )}
      </section>

      <section>
        <SectionHeading>CLI reference</SectionHeading>
        <p className="mb-3 text-c-md text-muted-foreground">
          Built in to Claude Code, and typed in its terminal rather than here.
        </p>
        {builtIn.length > 0 ? (
          <LibraryGrid>
            {builtIn.map((c) => (
              <LibraryCard
                key={c.name}
                name={c.name}
                description={c.description}
                Icon={SquareTerminal}
              />
            ))}
          </LibraryGrid>
        ) : (
          <EmptyNote>Nothing matches here.</EmptyNote>
        )}
      </section>

      {open && (
        <PreviewDialog
          open
          onClose={() => setOpen(null)}
          name={`/${open.name}`}
          description={open.description}
          filePath={open.filePath}
          kind="Command"
          onDelete={async () => {
            await window.api.commands.delete(open.filePath)
            window.dispatchEvent(new Event('nyra:commands-changed'))
            reload()
          }}
          actions={
            <>
              <DialogAction
                onClick={() => {
                  openFileInPanel(open.filePath)
                  setOpen(null)
                }}
              >
                Open file
              </DialogAction>
              <DialogAction
                primary
                onClick={() => {
                  setPendingAction({ type: 'send', text: `/${open.name}` })
                  setMainView('chat')
                  setOpen(null)
                }}
              >
                Use
              </DialogAction>
            </>
          }
        />
      )}
    </Page>
  )
}

function MemoryView(): React.JSX.Element {
  return (
    <Page
      title="Memory"
      Icon={Brain}
      blurb="What Claude remembers between sessions, here and everywhere."
    >
      <Suspense fallback={<p className="text-c-md text-muted-foreground">Loading…</p>}>
        <MemoryTab />
      </Suspense>
    </Page>
  )
}

/** Whichever page the rail's nav has selected. */
export default function MainViews({
  view
}: {
  view: 'skills' | 'commands' | 'memory'
}): React.JSX.Element {
  if (view === 'skills') return <SkillsView />
  if (view === 'commands') return <CommandsView />
  return <MemoryView />
}
