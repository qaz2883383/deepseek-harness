/**
 * The task-board channel this workbench copy reads. ui-board publishes its
 * right-column Session on the document element — an attribute for the value,
 * an event for the change — the same DOM-bus convention the board shell
 * attribute uses in @workbench/ui-layout. Every reader gates on the
 * task-board panel being the active one, so a stale attribute never speaks
 * outside the board.
 */

/** The task-board panel's id (ui-board's PANEL_ID). */
export const BOARD_PANEL_ID = 'task-board'

/** Document attribute ui-board maintains with its right-column Session id. */
export const BOARD_SESSION_ATTRIBUTE = 'data-dsh-board-session'

/** DOM event ui-board dispatches whenever that attribute changes. */
export const BOARD_SESSION_EVENT = 'dsh-board-session'

/** The board's right-column Session while the board panel is the active one. */
export function boardSessionWhileBoardActive(activePanelId: string | null): string | undefined {
  return activePanelId === BOARD_PANEL_ID
    ? document.documentElement.getAttribute(BOARD_SESSION_ATTRIBUTE) ?? undefined
    : undefined
}

/** Listen for ui-board's Session publications; returns the unsubscribe. */
export function subscribeBoardSession(listener: () => void): () => void {
  document.addEventListener(BOARD_SESSION_EVENT, listener)
  return () => { document.removeEventListener(BOARD_SESSION_EVENT, listener) }
}
