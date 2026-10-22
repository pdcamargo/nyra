import { useSessionsStore } from '../store/sessions'
import { capabilitiesOf, type Capabilities } from '../lib/providers'

/** What the chat in front of you can do. Selects the provider alone, so a new
 *  message in the chat does not re-render whatever asks. */
export function useCapabilities(): Capabilities {
  const provider = useSessionsStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.provider)
  return capabilitiesOf({ provider })
}
