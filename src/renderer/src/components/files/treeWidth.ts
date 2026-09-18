/**
 * The split between the preview and the tree, inside a file tab.
 *
 * Deliberately not a `PanelKey`. Everything in `panelSizes.ts` answers "how much
 * of the *window* is left for the conversation" — the three rails are clamped
 * against CHAT_MIN_WIDTH and against each other. This split is constrained by
 * the panel it lives in, not the viewport, and its width is per chat with no
 * global consumer, so routing it through that machinery would mean two writes
 * per drag frame for strictly less correctness.
 */
export const TREE_DEFAULT_WIDTH = 180
export const TREE_MIN_WIDTH = 120
export const PREVIEW_MIN_WIDTH = 160

/** Below this the two panes cannot both exist, so the tree hides rather than
 *  squeezing the preview into nothing. */
export const TREE_MIN_PANEL_WIDTH = TREE_MIN_WIDTH + PREVIEW_MIN_WIDTH

/**
 * Can the tree be on screen at all at this panel width?
 *
 * Note PANEL_MINS.rightPanelWidth is 200, which is less than the 280 the two
 * panes need — so this is reachable by dragging, not a theoretical case.
 */
export function treeFits(panelWidth: number): boolean {
  return panelWidth >= TREE_MIN_PANEL_WIDTH
}

/**
 * A dragged width, clamped to what the panel can give it.
 *
 * Never written back when the panel is too narrow — same rule as `clampWidths`:
 * a temporarily cramped window must not destroy a width set on a roomy one.
 */
export function clampTreeWidth(candidate: number, panelWidth: number): number {
  const ceiling = Math.max(TREE_MIN_WIDTH, panelWidth - PREVIEW_MIN_WIDTH)
  const wanted = Number.isFinite(candidate) ? candidate : TREE_DEFAULT_WIDTH
  return Math.max(TREE_MIN_WIDTH, Math.min(wanted, ceiling))
}
