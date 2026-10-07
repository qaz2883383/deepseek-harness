import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { BoardInjected } from './index.ts'
import { NS } from './locales.ts'
import css from './BoardAction.module.css'

/** Structural view of one client session summary; the sessions store's row. */
interface SessionRow {
  readonly id: string
  readonly displayTitle: string
  readonly running: boolean
}

/** One stacked completion toast. */
interface CompletionToast {
  readonly key: string
  readonly sessionId: string
  readonly title: string
}

const EMPTY_ROWS: readonly SessionRow[] = []
const TOAST_LIFETIME_MS = 8_000

/** Full props for the frame-level toast overlay. */
export type BoardToastsProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & BoardInjected & { readonly useSessions: UseSessions }

/**
 * Frame-level completion notices: a session observed running that is no
 * longer running completed its work while nobody watched. Mounted for the
 * whole frame through the shell overlay slot, so it works in every panel.
 */
export function BoardToasts({ useSessions, openBoardSession, t }: BoardToastsProps) {
  const byId = useSessions(state => state.byId) as Record<string, SessionRow> | undefined
  const rows = useMemo(() => {
    return byId === undefined ? EMPTY_ROWS : Object.values(byId)
  }, [byId])
  const [toasts, setToasts] = useState<readonly CompletionToast[]>([])
  const previousRunning = useRef<Readonly<Record<string, boolean>>>({})

  // The first observation only seeds the baseline, so page load never
  // notifies; every later running -> idle transition does.
  useEffect(() => {
    const previous = previousRunning.current
    const next: Record<string, boolean> = {}
    for (const row of rows) next[row.id] = row.running
    previousRunning.current = next
    const completed = rows.filter(row => previous[row.id] === true && row.running === false)
    if (completed.length === 0) return
    const stamp = Date.now()
    const created = completed.map(row => ({ key: `${row.id}-${stamp}`, sessionId: row.id, title: row.displayTitle }))
    setToasts(current => [...current, ...created])
    for (const toast of created) {
      setTimeout(() => {
        setToasts(current => current.filter(entry => entry.key !== toast.key))
      }, TOAST_LIFETIME_MS)
    }
  }, [rows])

  const dismissToast = (key: string): void => {
    setToasts(current => current.filter(entry => entry.key !== key))
  }

  if (toasts.length === 0) return null
  return createPortal((
    <div className={css.toasts} aria-live="polite">
      {toasts.map(toast => (
        <button
          key={toast.key}
          type="button"
          className={css.toast}
          onClick={() => { dismissToast(toast.key); openBoardSession(toast.sessionId) }}
        >
          <span className={css.toastBadge}>{t('notify.title')}</span>
          <span className={css.toastTitle}>{toast.title}</span>
        </button>
      ))}
    </div>
  ), document.body)
}
