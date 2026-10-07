/** Browser half of the personal workbench task board. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BoardPanelIcon } from './BoardPanelIcon.tsx'
import { BoardToasts } from './BoardToasts.tsx'
import { BoardView } from './BoardView.tsx'
import { BoardConversationPanel } from './BoardConversationPanel.tsx'
import { en, NS, zh, type BoardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Session retained for the task board's right-column conversation. */
    boardChat: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Session-scoped Conversation occurrence hosted by the board's right column. */
    'board.conversation': { kind: 'single'; scope: 'session' }
  }

  interface LocaleNamespaceMap {
    /** Personal workbench task board copy. */
    'board.catalog': BoardKey
  }
}

/** Navigation callbacks handed to the board components. */
export interface BoardInjected {
  /**
   * Open one task conversation in the board's right column. The board panel
   * is selected first, so the jump never leaves the workbench shell for the
   * main-view Conversation.
   */
  openBoardSession: (sessionId: string) => void
  /**
   * Retain one session for the board's right column; `undefined` releases.
   * The reference's lifetime is the caller's (release explicitly).
   */
  retainBoardSession: (sessionId: string | undefined, signal: AbortSignal) => SessionReference | undefined
  /** Pull one session's projection baseline (schedule data) once. */
  refreshProjections: (sessionId: string) => void
  /** List every retained reminder across sessions (the host schedule catalog). */
  fetchScheduleCatalog: () => Promise<readonly ScheduleCatalogEntry[] | undefined>
  /** Subscribe to host schedule changes; returns the unsubscribe function. */
  subscribeScheduleChanged: (listener: () => void) => () => void
  /** Start a New Session flow in the current workspace. */
  startSession: () => void
  /** Toggle the native sidebar (fully hidden while collapsed in this shell). */
  toggleSidebar: () => void
  /**
   * Open the shell settings panel. The settings shell keeps its open state
   * internal, so this reaches the sidebar's trigger programmatically and
   * falls back to revealing the sidebar when the trigger cannot be found.
   */
  openSettings: () => void
}

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'task-board' as MainPanelId

/** One-shot guard: hide the native sidebar once per page load (toggle is
 * bidirectional, so a plugin reload must not re-toggle it open). */
let sidebarHiddenOnce = false

/**
 * Session requests from frame-level surfaces (the completion toasts): the
 * mounted BoardView follows them live through its subscription, and a request
 * that arrives while the board is unmounted waits for the mount the caller's
 * panel selection is about to trigger.
 */
let requestedBoardSessionId: string | undefined
const boardSessionListeners = new Set<(sessionId: string) => void>()

/** Hand one session to the mounted board's right column. */
function requestBoardSession(sessionId: string): void {
  requestedBoardSessionId = sessionId
  const mounted = [...boardSessionListeners]
  for (const listener of mounted) listener(sessionId)
  // A mounted board followed the session live; without one the request stays
  // pending for the board the caller's selectPanel is about to mount.
  if (mounted.length > 0) requestedBoardSessionId = undefined
}

/** Subscribe the mounted board to session requests; returns the unsubscribe. */
export function subscribeBoardSession(listener: (sessionId: string) => void): () => void {
  boardSessionListeners.add(listener)
  return () => { boardSessionListeners.delete(listener) }
}

/** Claim the request that arrived while the board was unmounted, if any. */
export function takeRequestedBoardSession(): string | undefined {
  const pending = requestedBoardSessionId
  requestedBoardSessionId = undefined
  return pending
}

/** Required services: slots/locale plus the session store and navigation. */
export const inject = ['slots', 'locale', 'uiWorkspace', 'sessions', 'layout', 'remote', 'remote.schedule']

/** Structural view of the client session manager the board uses. */
interface SessionsServiceLike {
  retain(target: string, options: { source: 'boardChat'; signal: AbortSignal }): SessionReference
  refreshProjections(sessionId: string): Promise<unknown>
}

/** Register the dictionaries, the main task-board panel, and the toast overlay. */
export function apply(ctx: ClientContext): void {
  // Mark this shell: the frame hides the collapsed sidebar entirely (no icon
  // rail) because the board re-homes its general controls.
  document.documentElement.setAttribute('data-dsh-board-shell', '')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-board: dictionaries')
  const bound = ctx.locale.bind(NS)
  // Structural reach: services are guaranteed by the inject declaration; the
  // cast keeps this package free of a session-controller type dependency.
  const sessionsService = (ctx as unknown as { sessions?: SessionsServiceLike }).sessions
  const boardInjected = (): BoardInjected => ({
    openBoardSession: (sessionId: string): void => {
      // The completion toast must land inside the board, never in the
      // main-view Conversation: this shell hides the native sidebar, so a
      // main-view switch both abandons the workbench and breaks the frame.
      // Select the board panel first (the toast fires from any panel), then
      // route the session to the mounted board — or leave it pending for
      // the mount the selection just scheduled.
      const layout = (ctx as unknown as { layout?: { selectPanel(panelId: string): void } }).layout
      try {
        layout?.selectPanel(PANEL_ID)
      } catch {
        // The layout service validates registered keys; a miss only means
        // the board is not selectable (yet) and the request stays pending.
      }
      requestBoardSession(sessionId)
    },
    retainBoardSession: (sessionId: string | undefined, signal: AbortSignal): SessionReference | undefined => {
      if (sessionId === undefined) return undefined
      return sessionsService?.retain(sessionId, { source: 'boardChat', signal })
    },
    refreshProjections: (sessionId: string): void => {
      void sessionsService?.refreshProjections(sessionId)
    },
    fetchScheduleCatalog: async (): Promise<readonly ScheduleCatalogEntry[] | undefined> => {
      const remote = (ctx as unknown as {
        remote?: { schedule?: { catalog(): Promise<{ ok: boolean; value: ScheduleCatalogEntry[] }> } }
      }).remote
      const result = await remote?.schedule?.catalog()
      return result?.ok === true ? result.value : undefined
    },
    subscribeScheduleChanged: (listener: () => void): (() => void) => {
      const remote = (ctx as unknown as {
        remote?: { $on?: (event: 'schedule/changed', listener: () => void) => (() => void) | undefined }
      }).remote
      return remote?.$on?.('schedule/changed', listener) ?? ((): void => {})
    },
    startSession: (): void => {
      const uiWorkspace = (ctx as unknown as { uiWorkspace?: { startSession(): void } }).uiWorkspace
      uiWorkspace?.startSession()
    },
    toggleSidebar: (): void => {
      const layout = (ctx as unknown as { layout?: { toggleSidebar(): void } }).layout
      layout?.toggleSidebar()
    },
    openSettings: (): void => {
      // The settings modal's open state lives inside its shell component with
      // no external command API, so reach the sidebar trigger (still mounted
      // behind the hidden column) and click it; unmatched locale or markup
      // falls back to revealing the sidebar for a manual tap.
      const pattern = /设置|settings/i
      const buttons = document.querySelectorAll('button')
      for (const button of buttons) {
        const label = button.getAttribute('aria-label') ?? button.textContent ?? ''
        if (pattern.test(label)) {
          button.click()
          return
        }
      }
      const layout = (ctx as unknown as { layout?: { toggleSidebar(): void } }).layout
      layout?.toggleSidebar()
    },
  })
  // 1. The main task-board panel: the three-column workbench. Its session
  //    child hosts the right-column Conversation for the selected session.
  ctx.slots.inject(
    'main',
    () => {
      const dispose = ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: boardInjected,
        children: { 'board.conversation': { kind: 'single', scope: 'session' } },
      }, BoardView)
      // The board IS the default main view: select it right after its key is
      // registered, before the first React render, so the app opens straight
      // into the three-column workbench, and hide the native sidebar (its
      // general controls are re-homed into the board's left column).
      const layout = (ctx as unknown as {
        layout?: { selectPanel(panelId: string): void; toggleSidebar(): void }
      }).layout
      try {
        layout?.selectPanel(PANEL_ID)
      } catch {
        // The layout service validates registered keys; a miss only means
        // this registration raced the layout store — the sidebar entry still
        // selects the panel.
      }
      try {
        if (!sidebarHiddenOnce) {
          sidebarHiddenOnce = true
          // Below the auto-collapse breakpoint (ui-layout's 1024px) the
          // sidebar already starts on its icon rail, and toggling there would
          // force it open over the squeezed center — only wide frames toggle.
          if (window.innerWidth >= 1024) layout?.toggleSidebar()
        }
      } catch {
        // A hidden or already-collapsed sidebar just stays as it is.
      }
      return dispose
    },
  )
  ctx.slots.inject(
    'board.conversation',
    () => ctx.slots.register({
      name: 'board.conversation',
    }, BoardConversationPanel),
  )
  // 2. The sidebar entry that selects the main panel.
  ctx.slots.inject(
    'sidebar.panellist',
    () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      // Plugins sits at 0; the board follows it.
      order: 20,
      label: () => bound('panel'),
      locale: NS,
    }, BoardPanelIcon),
  )
  // 3. Frame-level completion toasts: mounted for the whole frame, so the
  //    "no watching required" notices work in every panel.
  ctx.slots.inject(
    'shell.overlay',
    () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'task-board-toasts',
      order: 100,
      locale: NS,
      inject: boardInjected,
    }, BoardToasts),
  )
}
