import type { Provider } from '@shared/types'

/**
 * What a chat can do, by the CLI it runs on.
 *
 * A control for something the chat's CLI cannot do is hidden rather than left
 * to fail. Read through {@link capabilitiesOf}, never by comparing providers in
 * a component: the day Codex can rewind, this table changes and nothing else.
 */
export type Capabilities = {
  /** Edit a sent message, regenerate a reply, fork at a message, switch versions. */
  rewind: boolean
  /** Put back the files a turn changed. */
  fileRestore: boolean
  /** `/btw` and Ask on a selection. */
  sideQuestions: boolean
  planMode: boolean
  /** The CLI's own slash commands, offered by the composer and passed through to it. */
  cliCommands: boolean
}

export const CAPABILITIES: Record<Provider, Capabilities> = {
  claude: { rewind: true, fileRestore: true, sideQuestions: true, planMode: true, cliCommands: true },
  codex: { rewind: true, fileRestore: false, sideQuestions: true, planMode: false, cliCommands: false }
}

export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' }

/**
 * An anchor the chat's CLI can resume from, or null. Each CLI's anchors point
 * into its own transcript, so one left by the other is history to recap, not a
 * place to fork from.
 */
export function anchorFor<A extends { provider?: Provider }>(session: { provider?: Provider }, anchor: A | null | undefined): A | null {
  if (!anchor) return null
  return (anchor.provider ?? 'claude') === (session.provider ?? 'claude') ? anchor : null
}

/** A chat from before providers, or none at all, runs on Claude. */
export function capabilitiesOf(session: { provider?: Provider } | null | undefined): Capabilities {
  return CAPABILITIES[session?.provider ?? 'claude']
}
