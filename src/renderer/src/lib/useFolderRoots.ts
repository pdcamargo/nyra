import { useMemo } from 'react'
import { cwdForSession, linkedFoldersForSession, useSessionsStore } from '../store/sessions'
import { folderRoots, type FolderRoot } from './folderRoots'

/** A chat's folders, main first. One entry when its project links none. */
export function useFolderRoots(sessionId: string | null | undefined): FolderRoot[] {
  const main = useSessionsStore((s) => cwdForSession(s, sessionId))
  const linked = useSessionsStore((s) => linkedFoldersForSession(s, sessionId))
  return useMemo(() => folderRoots(main, linked), [main, linked])
}
