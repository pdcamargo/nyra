import { useResourceDockStore, type ResourceDockKind } from '../store/resourceDock'

/** Open a live composer resource. Neither leaves anything in the transcript:
 *  the card is the answer, and a link left behind outlived the reason for it. */
export function showResource(sessionId: string, kind: ResourceDockKind): void {
  useResourceDockStore.getState().open(sessionId, kind)
}
