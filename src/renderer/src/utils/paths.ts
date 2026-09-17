/**
 * Resolve a path Claude printed against the directory its chat runs in.
 *
 * Shared by the file-preview modal and the markdown image renderer. Both take a
 * path straight out of Claude's output, and two copies of this rule would drift.
 */
export function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith('/')) return filePath
  // Strip leading ./ if present
  const cleaned = filePath.startsWith('./') ? filePath.slice(2) : filePath
  return `${cwd.replace(/\/$/, '')}/${cleaned}`
}
