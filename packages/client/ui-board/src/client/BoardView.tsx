import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { BoardInjected } from './index.ts'
import { NS } from './locales.ts'
import css from './BoardAction.module.css'

/** One plan item, mirrored from the host tasks plugin. */
interface PlanItem {
  readonly id: string
  readonly content: string
  readonly priority: 'high' | 'medium' | 'low'
  readonly done: boolean
  readonly deadline?: string | undefined
}

/** One task record, mirrored from the host tasks plugin. */
interface TaskRecord {
  readonly id: string
  readonly title: string
  readonly purpose: string
  readonly plan: readonly PlanItem[]
  readonly progress: string
  readonly status: 'active' | 'done'
  readonly category: 'work' | 'learning'
  readonly pinned?: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly sessions: readonly string[]
}

/** Structural view of one client session summary; the sessions store's row. */
interface SessionRow {
  readonly id: string
  readonly displayTitle: string
  readonly origin?: 'subagent'
  readonly running: boolean
  readonly cwd?: string
  readonly retainedBy?: { readonly mainView?: number }
  readonly updatedAt?: number
  /** Fork or subagent parent (the client summary spells it parentId). */
  readonly parentId?: string
}

/** One preference category, mirrored from the host preferences plugin. */
type Category = 'work' | 'learning'

/** The `/preferences` route's GET body. */
interface PreferencesState {
  readonly work: string
  readonly learning: string
  readonly selections: Readonly<Record<string, Category>>
}

/** One wall filter: which tasks the left column shows. */
type WallFilter = 'all' | 'running' | 'done'

/** The middle column's tab. */
type DetailTab = 'detail' | 'calendar'

/** Mirror of the host tasks plugin's catch-all task id (task-misc). */
const MISC_TASK_ID = 'task-misc'

const EMPTY_TASKS: readonly TaskRecord[] = []
const EMPTY_ROWS: readonly SessionRow[] = []
const EMPTY_SELECTIONS: Readonly<Record<string, Category>> = {}
const POLL_INTERVAL_MS = 5_000

function routeToken(name: string): string | undefined {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? undefined
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  const response = await fetch(url)
  if (!response.ok) return undefined
  return await response.json() as T
}

async function postTasks(body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const token = routeToken('dsh-tasks')
  if (token === undefined) return undefined
  const response = await fetch(`/tasks?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) return undefined
  return await response.json() as Record<string, unknown>
}

/** Read all tasks; failures keep the previous snapshot. */
async function fetchTasks(): Promise<readonly TaskRecord[] | undefined> {
  const token = routeToken('dsh-tasks')
  if (token === undefined) return undefined
  const state = await fetchJson<{ tasks: TaskRecord[] }>(`/tasks?token=${encodeURIComponent(token)}`)
  return state?.tasks
}

/** Read the preferences state; failures keep the previous snapshot. */
async function fetchPreferences(): Promise<PreferencesState | undefined> {
  const token = routeToken('dsh-preferences')
  if (token === undefined) return undefined
  return await fetchJson<PreferencesState>(`/preferences?token=${encodeURIComponent(token)}`)
}

/** Write one profile through the preferences route. */
async function writeProfile(category: Category, content: string): Promise<void> {
  const token = routeToken('dsh-preferences')
  if (token === undefined) return
  await fetch(`/preferences?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'setProfile', category, content }),
  })
}

/** Locale-aware short relative time ("3 minutes ago"). */
function relativeTime(updatedAt: number | undefined): string {
  if (updatedAt === undefined) return ''
  const rtf = new Intl.RelativeTimeFormat(navigator.language, { numeric: 'auto' })
  const minutes = Math.round((updatedAt - Date.now()) / 60_000)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
  return rtf.format(Math.round(hours / 24), 'day')
}

/** Local `YYYY-MM-DD` for one instant. */
function dateKey(instant: Date): string {
  const month = String(instant.getMonth() + 1).padStart(2, '0')
  const day = String(instant.getDate()).padStart(2, '0')
  return `${instant.getFullYear()}-${month}-${day}`
}

/** Local `HH:mm` for one instant. */
function timeLabel(instant: Date): string {
  return `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`
}

/** Whether an active task has a plan item due today or overdue. */
function taskOverdue(task: TaskRecord): boolean {
  if (task.status !== 'active') return false
  const today = dateKey(new Date())
  return task.plan.some(item => !item.done && item.deadline !== undefined && item.deadline <= today)
}

/**
 * The calendar chip label: the owning task's title (before the plan-content
 * separator). Width is left to CSS truncation so a wider middle column shows
 * more characters.
 */
function calendarChipLabel(event: CalendarEvent): string {
  return (event.label.split(' · ')[0] ?? event.label).trim()
}

/** One calendar day entry: a reminder due or a plan closure date. */
interface CalendarEvent {
  readonly date: string
  readonly time?: string
  readonly kind: 'schedule' | 'deadline'
  readonly label: string
  readonly sessionId?: string
  readonly sessionTitle?: string
  readonly scheduleId?: string
  readonly overdue?: boolean
  readonly repeatSeconds?: number
}

/** Full props for the task board; mounted as the main panel. */
export type BoardViewProps =
  PropsLocale<typeof NS> & BoardInjected & PropsRenderSlots<'board.conversation'> & {
    readonly useSessions: UseSessions
    /** Root-scope workspaces hook; supplies the archive set when present. */
    readonly useWorkspaces?: (selector: (state: { readonly archivedSessionIds?: readonly string[] }) => unknown) => unknown
  }

/** The three-column workbench: sticky wall, task detail or calendar, conversation. */
export function BoardView({
  useSessions, useWorkspaces, retainBoardSession, refreshProjections,
  fetchScheduleCatalog, subscribeScheduleChanged,
  openSettings, renderSlot, SessionProvider, t,
}: BoardViewProps) {
  const byId = useSessions(state => state.byId) as Record<string, SessionRow> | undefined
  const archivedIds = useWorkspaces?.(state => state.archivedSessionIds) as readonly string[] | undefined
  const archived = useMemo(() => new Set(archivedIds ?? []), [archivedIds])
  const [tasks, setTasks] = useState<readonly TaskRecord[]>(EMPTY_TASKS)
  const [tasksReady, setTasksReady] = useState(false)
  const [filter, setFilter] = useState<WallFilter>('all')
  const [selectedTaskId, setSelectedTaskId] = useState<string>(MISC_TASK_ID)
  const [tab, setTab] = useState<DetailTab>('detail')
  const [editing, setEditing] = useState<TaskRecord | 'new' | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [selections, setSelections] = useState<Readonly<Record<string, Category>>>(EMPTY_SELECTIONS)
  const [taskQuery, setTaskQuery] = useState('')
  // Web-notification permission; the reminder toast only reaches the OS when
  // the host browser (a real Chrome/Edge window, not an embedded preview)
  // has been granted permission.
  const [notifyPermission, setNotifyPermission] = useState<string>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const requestSystemNotify = (): void => {
    if (typeof Notification === 'undefined') return
    void Notification.requestPermission().then((permission) => { setNotifyPermission(permission) })
  }
  // ---- Column resizing ----------------------------------------------------
  const [notesWidth, setNotesWidth] = useState(236)
  const [detailWidth, setDetailWidth] = useState(340)
  const dragState = useRef<{ readonly kind: 'notes' | 'detail'; readonly startX: number; readonly startWidth: number } | null>(null)

  const onResizeStart = (kind: 'notes' | 'detail') => (event: React.PointerEvent<HTMLDivElement>): void => {
    dragState.current = { kind, startX: event.clientX, startWidth: kind === 'notes' ? notesWidth : detailWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragState.current
    if (drag === null) return
    const delta = event.clientX - drag.startX
    if (drag.kind === 'notes') setNotesWidth(Math.min(460, Math.max(200, drag.startWidth + delta)))
    else setDetailWidth(Math.min(720, Math.max(280, drag.startWidth + delta)))
  }
  const onResizeEnd = (): void => {
    dragState.current = null
  }

  // ---- Right-column conversation binding --------------------------------
  const [boardSessionId, setBoardSessionId] = useState<string | undefined>(undefined)
  const [boardRef, setBoardRef] = useState<SessionReference | undefined>(undefined)
  const lifetime = useRef(new AbortController())
  // The retained reference lives in a ref so releasing it is never a render
  // side effect (StrictMode double-invokes state updaters).
  const boardRefRef = useRef<SessionReference | undefined>(undefined)
  // Inject props may be rebuilt per render; keeping the callback in a ref
  // keeps selectBoardSession referentially stable, so effects that depend on
  // it cannot be dragged into update loops.
  const retainRef = useRef(retainBoardSession)
  retainRef.current = retainBoardSession
  const refreshRef = useRef(refreshProjections)
  refreshRef.current = refreshProjections

  useEffect(() => () => {
    boardRefRef.current?.release()
    boardRefRef.current = undefined
    lifetime.current.abort()
  }, [])

  const selectBoardSession = useCallback((sessionId: string | undefined): boolean => {
    boardRefRef.current?.release()
    boardRefRef.current = undefined
    setBoardRef(undefined)
    setBoardSessionId(sessionId)
    if (sessionId === undefined) return true
    try {
      const reference = retainRef.current?.(sessionId, lifetime.current.signal)
      if (reference !== undefined) {
        boardRefRef.current = reference
        setBoardRef(reference)
        return true
      }
    } catch {
      // Unknown or racing session: the column stays empty for now.
    }
    return false
  }, [])

  // Default the right column to the main-view session exactly once; when the
  // board is the opening view there is no main-view retention yet, so fall
  // back to the most recently updated ordinary session. A failed retain must
  // not retrigger on the next store update.
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current || byId === undefined) return
    const ordinary = Object.values(byId).filter(row => row.origin !== 'subagent')
    if (ordinary.length === 0) return
    bootstrapped.current = true
    const main = ordinary.find(row => (row.retainedBy?.mainView ?? 0) > 0)
      ?? [...ordinary].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]
    if (main !== undefined) selectBoardSession(main.id)
  }, [byId, selectBoardSession])

  const refreshTasks = useCallback(async (): Promise<void> => {
    const next = await fetchTasks()
    if (next !== undefined) {
      setTasks(next)
      setTasksReady(true)
    }
  }, [])

  // Reminders live in the host's global schedule storage (0.2.1): fetch the
  // catalog once, then follow its change stream.
  const [scheduleCatalog, setScheduleCatalog] = useState<readonly ScheduleCatalogEntry[]>([])
  const refreshScheduleCatalog = useCallback(async (): Promise<void> => {
    const next = await fetchScheduleCatalog()
    if (next !== undefined) setScheduleCatalog(next)
  }, [fetchScheduleCatalog])
  useEffect(() => {
    void refreshScheduleCatalog()
    return subscribeScheduleChanged(() => { void refreshScheduleCatalog() })
  }, [refreshScheduleCatalog, subscribeScheduleChanged])

  useEffect(() => {
    void refreshTasks()
    const timer = setInterval(() => { void refreshTasks() }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [refreshTasks])

  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const state = await fetchPreferences()
      if (!cancelled && state !== undefined) setSelections(state.selections)
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // A freshly created Session reaches the client directory through the
  // session-added event; retry navigation until it lands (retain reports
  // failure for unknown ids).
  const openSessionWhenReady = useCallback((sessionId: string, attempt = 0): void => {
    if (selectBoardSession(sessionId)) return
    if (attempt < 25) setTimeout(() => { openSessionWhenReady(sessionId, attempt + 1) }, 300)
  }, [selectBoardSession])

  const rows = byId === undefined ? EMPTY_ROWS : Object.values(byId)
  const sessionOf = (id: string): SessionRow | undefined => byId?.[id]
  const taskRunning = (task: TaskRecord): boolean =>
    task.sessions.some(id => sessionOf(id)?.running === true)

  // Pull the schedule projection baseline once per session row (live rows
  // then update through the control stream on their own). The dedupe ref
  // makes reruns no-ops, and the store-derived dependency keeps it stable.
  const projected = useRef(new Set<string>())
  useEffect(() => {
    for (const row of byId === undefined ? [] : Object.values(byId)) {
      if (row.origin === 'subagent' || projected.current.has(row.id)) continue
      projected.current.add(row.id)
      refreshRef.current(row.id)
    }
  }, [byId])

  // A forked conversation joins its source's task: a newly listed ordinary
  // session with a parentId is a fork child (subagents carry origin
  // 'subagent'; fresh creations carry no parent). Attach it to the parent's
  // task and follow it in the right column when it branched from the session
  // being viewed.
  const handledForks = useRef(new Set<string>())
  useEffect(() => {
    if (byId === undefined || !tasksReady) return
    for (const row of Object.values(byId)) {
      if (row.origin === 'subagent' || row.parentId === undefined || handledForks.current.has(row.id)) continue
      const parent = byId[row.parentId]
      if (parent === undefined) continue
      handledForks.current.add(row.id)
      const parentTask = tasks.find(task => task.sessions.includes(parent.id))
      if (parentTask !== undefined) {
        void (async () => {
          await postTasks({ op: 'attachSession', taskId: parentTask.id, sessionId: row.id })
          await refreshTasks()
        })()
      }
      if (boardSessionId === parent.id) selectBoardSession(row.id)
    }
  }, [byId, tasks, tasksReady, boardSessionId, selectBoardSession, refreshTasks])

  // Explicitly attached sessions; the catch-all task additionally absorbs
  // every session nobody assigned, so all conversations have a home.
  const attached = useMemo(() => new Set(tasks.flatMap(task => task.sessions)), [tasks])
  const hasMiscTask = tasks.some(task => task.id === MISC_TASK_ID)
  const unassigned = useMemo(() => rows
    .filter(row => row.origin !== 'subagent' && !attached.has(row.id) && !archived.has(row.id))
    .sort((left, right) => Number(right.running) - Number(left.running)), [rows, attached, archived])
  // The catch-all note lists its assigned sessions plus the unassigned ones,
  // so every conversation shows up under exactly one task.
  const mergedTasks = useMemo(() => hasMiscTask
    ? tasks.map(task => task.id === MISC_TASK_ID
      ? { ...task, sessions: [...task.sessions, ...unassigned.map(row => row.id)] }
      : task)
    : tasks, [tasks, hasMiscTask, unassigned])
  // Board order: pinned tasks first, then the rest in creation order (the
  // store keeps newest first), with the catch-all task always last.
  const displayTasks = useMemo(() => {
    const rank = (task: TaskRecord): number => {
      if (task.pinned === true) return 0
      return task.id === MISC_TASK_ID ? 2 : 1
    }
    return [...mergedTasks].sort((left, right) => rank(left) - rank(right))
  }, [mergedTasks])

  const normalizedQuery = taskQuery.trim().toLowerCase()
  const visible = useMemo(() => {
    const byStatus = (task: TaskRecord): boolean => {
      if (filter === 'done') return task.status === 'done'
      if (filter === 'running') return task.status === 'active' && taskRunning(task)
      return true
    }
    return displayTasks.filter(task => byStatus(task)
      && (normalizedQuery === '' || task.title.toLowerCase().includes(normalizedQuery)
        || task.purpose.toLowerCase().includes(normalizedQuery)))
  }, [displayTasks, filter, normalizedQuery])

  // Calendar events across all sessions and task closure dates.
  const events = useMemo<readonly CalendarEvent[]>(() => {
    const list: CalendarEvent[] = []
    const now = Date.now()
    for (const task of tasks) {
      for (const item of task.plan) {
        if (item.deadline === undefined) continue
        list.push({
          date: item.deadline,
          kind: 'deadline',
          label: `${task.title} · ${item.content}`,
        })
      }
    }
    for (const record of scheduleCatalog) {
      const row = rows.find(entry => entry.id === record.sessionId)
      const instant = new Date(record.scheduledAt)
      const pushOccurrence = (at: Date): void => {
        list.push({
          date: dateKey(at),
          time: timeLabel(at),
          kind: 'schedule',
          label: record.title,
          sessionId: record.sessionId,
          ...(row === undefined ? {} : { sessionTitle: row.displayTitle }),
          scheduleId: record.id,
          overdue: at.getTime() <= now,
          ...(record.kind === 'every' && record.everySeconds !== undefined ? { repeatSeconds: record.everySeconds } : {}),
        })
      }
      pushOccurrence(instant)
      // A fixed-rate reminder also shows its next few occurrences.
      if (record.kind === 'every' && record.everySeconds !== undefined) {
        for (let step = 1; step <= 3; step += 1) {
          pushOccurrence(new Date(instant.getTime() + step * record.everySeconds * 1000))
        }
      }
    }
    return list
  }, [tasks, rows, scheduleCatalog])

  const selectedTask = useMemo(
    () => displayTasks.find(task => task.id === selectedTaskId) ?? displayTasks[0],
    [displayTasks, selectedTaskId],
  )

  const run = useCallback(async (op: () => Promise<unknown>): Promise<void> => {
    await op()
    await refreshTasks()
  }, [refreshTasks])

  const filters: readonly WallFilter[] = ['all', 'running', 'done']
  const countOf = (key: WallFilter): number => {
    if (key === 'all') return displayTasks.length
    if (key === 'running') return displayTasks.filter(task => task.status === 'active' && taskRunning(task)).length
    return displayTasks.filter(task => task.status === 'done').length
  }

  const editor = editing !== null
    ? createPortal(
      <TaskEditor
        task={editing === 'new' ? undefined : editing}
        onClose={() => { setEditing(null) }}
        onSaved={() => { setEditing(null); void refreshTasks() }}
        t={t}
      />, document.body)
    : null
  const prefs = prefsOpen
    ? createPortal(<PreferencesEditor onClose={() => { setPrefsOpen(false) }} t={t} />, document.body)
    : null

  return (
    <div
      className={css.workbench}
      style={{ gridTemplateColumns: `${notesWidth}px 5px ${detailWidth}px 5px minmax(280px, 1fr)` }}
      aria-label={t('board.aria')}
    >
      <aside className={css.notesColumn} aria-label={t('board.aria')}>
        <div className={css.notesHead}>
          <button type="button" className={css.newTaskButton} onClick={() => { setEditing('new') }}>
            {t('task.new')}
          </button>
          <div className={css.notesTools}>
            {notifyPermission !== 'unsupported'
              ? <button
                type="button"
                className={notifyPermission === 'granted' ? `${css.toolButton} ${css.toolButtonActive}` : css.toolButton}
                disabled={notifyPermission !== 'default'}
                title={notifyPermission === 'granted'
                  ? t('notify.on')
                  : notifyPermission === 'denied' ? t('notify.blocked') : t('notify.enable')}
                onClick={requestSystemNotify}
              >
                🔔
              </button>
              : null}
            <button type="button" className={css.toolButton} onClick={() => { setPrefsOpen(true) }} title={t('prefs.open')}>
              ✎
            </button>
            <button type="button" className={css.toolButton} onClick={() => { openSettings() }} title={t('shell.settings')}>
              ⚙
            </button>
          </div>
        </div>
        <div className={css.notesFilters}>
          {filters.map(key => (
            <button
              key={key}
              type="button"
              className={filter === key ? `${css.filterTab} ${css.filterTabActive}` : css.filterTab}
              aria-pressed={filter === key}
              onClick={() => { setFilter(key) }}
            >
              {t(`filter.${key}`)}
              <span className={css.filterCount}>{countOf(key)}</span>
            </button>
          ))}
        </div>
        <div className={css.notesSearch}>
          <input
            type="search"
            className={css.searchInput}
            placeholder={t('search.tasks')}
            value={taskQuery}
            aria-label={t('search.tasks')}
            onChange={(event) => { setTaskQuery(event.target.value) }}
          />
        </div>
        {!tasksReady || visible.length === 0
          ? <p className={css.empty}>{tasksReady ? t('search.noMatch') : '…'}</p>
          : <ul className={css.notesList}>
            {visible.map((task) => {
              const running = taskRunning(task)
              const overdue = taskOverdue(task)
              const doneCount = task.plan.filter(item => item.done).length
              const percent = task.plan.length === 0 ? undefined : Math.round((doneCount / task.plan.length) * 100)
              return (
                <li key={task.id} className={task.pinned === true ? css.noteRowPinned : undefined}>
                  <button
                    type="button"
                    className={task.id === selectedTask?.id ? `${css.noteCard} ${css.noteCardSelected}` : css.noteCard}
                    onClick={() => { setSelectedTaskId(task.id); setTab('detail') }}
                  >
                    <span className={[
                      css.noteDot,
                      overdue ? css.noteDotOverdue : '',
                      !overdue && running ? css.noteDotRunning : '',
                      !overdue && !running && task.status === 'done' ? css.noteDotDone : '',
                    ].filter(name => name !== '').join(' ')} />
                    <span className={css.noteTitle}>{task.title}</span>
                    <span className={css.noteMeta}>
                      <span className={`${css.noteBadge} ${task.category === 'learning' ? css.noteBadgeLearning : css.noteBadgeWork}`}>
                        {t(`note.${task.category}`)}
                      </span>
                      <span className={css.notePercent}>{percent === undefined ? t('plan.noPlan') : `${percent}%`}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={task.pinned === true ? `${css.notePin} ${css.notePinActive}` : css.notePin}
                    title={t(task.pinned === true ? 'task.unpin' : 'task.pin')}
                    aria-label={t(task.pinned === true ? 'task.unpin' : 'task.pin')}
                    onClick={() => {
                      void run(() => postTasks({ op: 'update', taskId: task.id, pinned: task.pinned !== true }))
                    }}
                  >
                    ↑
                  </button>
                </li>
              )
            })}
          </ul>}
      </aside>

      <div
        className={css.colHandle}
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeStart('notes')}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />

      <section className={css.detailColumn}>
        <div className={css.detailTabs}>
          <button
            type="button"
            className={tab === 'detail' ? `${css.detailTab} ${css.detailTabActive}` : css.detailTab}
            onClick={() => { setTab('detail') }}
          >
            {t('tab.detail')}
          </button>
          <button
            type="button"
            className={tab === 'calendar' ? `${css.detailTab} ${css.detailTabActive}` : css.detailTab}
            onClick={() => { setTab('calendar') }}
          >
            {t('tab.calendar')}
          </button>
        </div>
        {tab === 'calendar'
          ? <CalendarPanel
            events={events}
            boardSessionId={boardSessionId}
            onCreated={() => { void refreshScheduleCatalog() }}
            onError={() => { window.alert(t('error.op')) }}
            t={t}
          />
          : selectedTask === undefined
            ? <p className={css.empty}>{t('detail.noTask')}</p>
            : <TaskDetail
              task={selectedTask}
              sessionOf={sessionOf}
              archived={archived}
              boardSessionId={boardSessionId}
              selectionOf={(id: string) => selections[id]}
              onOpenBoardSession={selectBoardSession}
              onEdit={() => { setEditing(selectedTask) }}
              onMarkDone={() => {
                void run(() => postTasks({ op: 'update', taskId: selectedTask.id, status: selectedTask.status === 'done' ? 'active' : 'done' }))
              }}
              onNewSession={() => {
                void run(async () => {
                  const result = await postTasks({ op: 'newSession', taskId: selectedTask.id })
                  if (result === undefined) {
                    window.alert(t('error.op'))
                    return
                  }
                  const sessionId = result.sessionId
                  if (typeof sessionId === 'string') openSessionWhenReady(sessionId)
                })
              }}
              onTogglePlanItem={(itemId: string, done: boolean) => {
                void run(() => postTasks({
                  op: 'update',
                  taskId: selectedTask.id,
                  plan: selectedTask.plan.map(item => item.id === itemId
                    ? { content: item.content, priority: item.priority, deadline: item.deadline, done }
                    : { content: item.content, priority: item.priority, deadline: item.deadline, done: item.done }),
                }))
              }}
              onDelete={() => {
                if (window.confirm(t('task.confirmDelete'))) void run(() => postTasks({ op: 'delete', taskId: selectedTask.id }))
              }}
              t={t}
            />}
      </section>

      <div
        className={css.colHandle}
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeStart('detail')}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />

      <section className={css.chatColumn}>
        {boardRef === undefined
          ? <p className={css.chatEmpty}>{t('chat.empty')}</p>
          : (
            <SessionProvider session={boardRef}>
              {renderSlot('board.conversation', {})}
            </SessionProvider>
          )}
      </section>

      {editor}
      {prefs}
    </div>
  )
}

/** The middle column's task detail: purpose, plan, progress, sessions, actions. */
function TaskDetail({ task, sessionOf, archived, boardSessionId, selectionOf, onOpenBoardSession,
  onEdit, onMarkDone, onNewSession, onTogglePlanItem, onDelete, t }: {
  task: TaskRecord
  sessionOf: (id: string) => SessionRow | undefined
  archived: ReadonlySet<string>
  boardSessionId: string | undefined
  selectionOf: (id: string) => Category | undefined
  onOpenBoardSession: (sessionId: string) => void
  onEdit: () => void
  onMarkDone: () => void
  onNewSession: () => void
  onTogglePlanItem: (itemId: string, done: boolean) => void
  onDelete: () => void
  t: BoardViewProps['t']
}) {
  const done = task.status === 'done'
  const [sessionQuery, setSessionQuery] = useState('')
  const normalizedQuery = sessionQuery.trim().toLowerCase()
  const sessions = task.sessions
    .filter(id => !archived.has(id))
    .filter(id => normalizedQuery === ''
      || (sessionOf(id)?.displayTitle ?? id).toLowerCase().includes(normalizedQuery))
  const doneCount = task.plan.filter(item => item.done).length
  const percent = task.plan.length === 0 ? undefined : Math.round((doneCount / task.plan.length) * 100)
  return (
    <div className={css.detailBody}>
      <header className={css.detailHead}>
        <h2 className={css.detailTitle}>{task.title}</h2>
        <div className={css.detailMeta}>
          <span className={`${css.noteBadge} ${task.category === 'learning' ? css.noteBadgeLearning : css.noteBadgeWork}`}>
            {t(`note.${task.category}`)}
          </span>
          <span className={done ? css.statusDone : css.statusActive}>{t(done ? 'task.done' : 'task.idle')}</span>
          {percent !== undefined
            ? <span className={css.detailProgress}>{doneCount}/{task.plan.length} · {percent}%</span>
            : null}
          <span className={css.detailTime}>{relativeTime(task.updatedAt)}</span>
        </div>
        <div className={css.detailActions}>
          <button type="button" className={css.detailAction} onClick={onNewSession}>{t('task.newSession')}</button>
          <button type="button" className={css.detailAction} onClick={onEdit}>{t('task.edit')}</button>
          <button type="button" className={css.detailAction} onClick={onMarkDone}>{t(done ? 'task.reopen' : 'task.markDone')}</button>
          {task.id === MISC_TASK_ID
            ? null
            : <button type="button" className={`${css.detailAction} ${css.detailActionDanger}`} onClick={onDelete}>{t('task.delete')}</button>}
        </div>
      </header>
      {percent !== undefined
        ? <div className={css.progressBar}><div className={css.progressBarFill} style={{ width: `${percent}%` }} /></div>
        : null}
      <div className={css.detailSection}>
        <h3 className={css.detailSectionTitle}>{t('task.purpose')}</h3>
        <p className={css.detailText}>{task.purpose.trim() === '' ? t('task.emptyField') : task.purpose}</p>
      </div>
      <div className={css.detailSection}>
        <h3 className={css.detailSectionTitle}>{t('task.plan')}</h3>
        {task.plan.length === 0
          ? <p className={css.detailText}>{t('plan.empty')}</p>
          : <ol className={css.planDetailList}>
            {task.plan.map(item => (
              <li key={item.id} className={item.done ? `${css.planDetailItem} ${css.planDetailItemDone}` : css.planDetailItem}>
                <input
                  type="checkbox"
                  className={css.planCheck}
                  checked={item.done}
                  aria-label={item.content}
                  onChange={(event) => { onTogglePlanItem(item.id, event.target.checked) }}
                />
                <span className={`${css.planPriority} ${item.priority === 'high' ? css.planPriorityHigh : item.priority === 'low' ? css.planPriorityLow : css.planPriorityMedium}`}>
                  {t(`priority.${item.priority}`)}
                </span>
                <span className={css.planDetailContent}>{item.content}</span>
                {item.deadline === undefined
                  ? null
                  : <span className={css.planDeadline} title={t('plan.deadline')}>◷ {item.deadline}</span>}
              </li>
            ))}
          </ol>}
      </div>
      <div className={css.detailSection}>
        <h3 className={css.detailSectionTitle}>{t('task.progress')}</h3>
        <p className={css.detailTextProgress}>{task.progress.trim() === '' ? t('task.emptyField') : task.progress}</p>
      </div>
      <div className={css.detailSection}>
        <h3 className={css.detailSectionTitle}>{t('task.sessions')} · {sessions.length}</h3>
        <input
          type="search"
          className={css.searchInput}
          placeholder={t('search.sessions')}
          value={sessionQuery}
          aria-label={t('search.sessions')}
          onChange={(event) => { setSessionQuery(event.target.value) }}
        />
        {task.sessions.filter(id => !archived.has(id)).length === 0
          ? <p className={css.detailText}>{t('task.none')}</p>
          : sessions.length === 0
            ? <p className={css.detailText}>{t('search.noMatch')}</p>
            : <ul className={css.noteSubList}>
              {sessions.map((id) => {
                const row = sessionOf(id)
                const category = selectionOf(id)
                return (
                  <li key={id} className={css.noteSubRow}>
                    <span className={row?.running === true ? `${css.noteSubDot} ${css.noteSubDotRunning}` : css.noteSubDot} />
                    <button
                      type="button"
                      className={id === boardSessionId ? `${css.sessionLink} ${css.sessionLinkActive}` : css.sessionLink}
                      onClick={() => { onOpenBoardSession(id) }}
                    >
                      <span className={css.noteSubTitle}>{row?.displayTitle ?? id}</span>
                    </button>
                    {category !== undefined
                      ? <span className={`${css.category} ${category === 'work' ? css.categoryWork : css.categoryLearning}`}>{t(`note.${category}`)}</span>
                      : null}
                  </li>
                )
              })}
            </ul>}
      </div>
    </div>
  )
}

/** Month-grid calendar over reminders and plan closure dates. */
function CalendarPanel({ events, boardSessionId, onCreated, onError, t }: {
  events: readonly CalendarEvent[]
  boardSessionId: string | undefined
  onCreated: () => void
  onError: () => void
  t: BoardViewProps['t']
}) {
  const today = dateKey(new Date())
  const [monthCursor, setMonthCursor] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })
  const [selectedDate, setSelectedDate] = useState(today)
  const [prompt, setPrompt] = useState('')
  const [time, setTime] = useState('09:00')
  const [creating, setCreating] = useState(false)

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      const bucket = map.get(event.date)
      if (bucket === undefined) map.set(event.date, [event])
      else bucket.push(event)
    }
    return map
  }, [events])

  const monthTitle = new Intl.DateTimeFormat(navigator.language, { year: 'numeric', month: 'long' }).format(new Date(monthCursor.year, monthCursor.month, 1))
  const leadingBlanks = (new Date(monthCursor.year, monthCursor.month, 1).getDay() + 6) % 7 // Monday-first
  const daysInMonth = new Date(monthCursor.year, monthCursor.month + 1, 0).getDate()
  const dayCells: readonly (string | undefined)[] = [
    ...Array.from({ length: leadingBlanks }, () => undefined),
    ...Array.from({ length: daysInMonth }, (_, index) => dateKey(new Date(monthCursor.year, monthCursor.month, index + 1))),
  ]
  const weekdayLabels = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(navigator.language, { weekday: 'narrow' }).format(new Date(2024, 0, index + 1)))

  const shiftMonth = (delta: number): void => {
    setMonthCursor((previous) => {
      const next = new Date(previous.year, previous.month + delta, 1)
      return { year: next.getFullYear(), month: next.getMonth() }
    })
  }

  const create = async (): Promise<void> => {
    if (boardSessionId === undefined || prompt.trim() === '' || selectedDate === '') return
    setCreating(true)
    try {
      const at = new Date(`${selectedDate}T${time}:00`)
      const result = await postTasks({ op: 'scheduleCreate', sessionId: boardSessionId, prompt: prompt.trim(), at: at.toISOString() })
      if (result === undefined) {
        onError()
        return
      }
      setPrompt('')
      onCreated()
    } finally {
      setCreating(false)
    }
  }

  const dayEvents = byDate.get(selectedDate) ?? []
  return (
    <div className={css.calendarBody}>
      <div className={css.calHead}>
        <button type="button" className={css.calNav} onClick={() => { shiftMonth(-1) }}>‹</button>
        <span className={css.calMonth}>{monthTitle}</span>
        <button type="button" className={css.calNav} onClick={() => { shiftMonth(1) }}>›</button>
        <button
          type="button"
          className={css.calToday}
          onClick={() => {
            const now = new Date()
            setMonthCursor({ year: now.getFullYear(), month: now.getMonth() })
            setSelectedDate(today)
          }}
        >
          {t('cal.today')}
        </button>
      </div>
      <div className={css.calGrid}>
        {weekdayLabels.map((label, index) => <span key={index} className={css.calWeekday}>{label}</span>)}
        {dayCells.map((date, index) => {
          if (date === undefined) return <span key={`blank-${index}`} className={css.calCell} />
          const dayEvents = byDate.get(date) ?? []
          const title = dayEvents.map(event => `${event.time ?? ''} ${event.label}`).join('\n')
          return (
            <button
              key={date}
              type="button"
              className={[
                css.calCell,
                css.calDay,
                date === today ? css.calDayToday : '',
                date === selectedDate ? css.calDaySelected : '',
              ].filter(name => name !== '').join(' ')}
              title={title}
              onClick={() => { setSelectedDate(date) }}
            >
              <span className={css.calDayNumber}>{Number(date.slice(-2))}</span>
              {dayEvents.length > 0
                ? <span className={css.calDayItems}>
                  {dayEvents.slice(0, 2).map((event, itemIndex) => (
                    <span
                      key={itemIndex}
                      className={event.kind === 'deadline' ? `${css.calDayItem} ${css.calDayItemDeadline}` : `${css.calDayItem} ${css.calDayItemSchedule}`}
                    >
                      <span className={event.kind === 'deadline' ? `${css.calDot} ${css.calDotDeadline}` : `${css.calDot} ${css.calDotSchedule}`} />
                      <span className={css.calDayItemLabel}>{calendarChipLabel(event)}</span>
                    </span>
                  ))}
                  {dayEvents.length > 2
                    ? <span className={css.calDayMore}>…</span>
                    : null}
                </span>
                : null}
            </button>
          )
        })}
      </div>
      <div className={css.calDayList}>
        <h3 className={css.detailSectionTitle}>{selectedDate}</h3>
        {dayEvents.length === 0
          ? <p className={css.detailText}>{t('cal.noEvents')}</p>
          : <ul className={css.calEvents}>
            {dayEvents.map((event, index) => (
              <li key={`${event.scheduleId ?? 'deadline'}-${index}`} className={css.calEvent}>
                <span className={`${css.calEventBadge} ${event.kind === 'deadline' ? css.calEventDeadline : css.calEventSchedule}`}>
                  {t(event.kind === 'deadline' ? 'cal.deadline' : 'cal.schedule')}
                </span>
                <span className={css.calEventTime}>{event.time ?? ''}</span>
                <span className={css.calEventLabel}>{event.label}</span>
                {event.repeatSeconds !== undefined
                  ? <span className={css.calEventRepeat}>{t('cal.repeat').replace('{seconds}', String(event.repeatSeconds))}</span>
                  : null}
                {event.overdue === true
                  ? <span className={css.calEventOverdue}>{t('cal.overdue')}</span>
                  : null}
                {event.sessionId !== undefined && event.scheduleId !== undefined
                  ? <button
                    type="button"
                    className={css.calEventCancel}
                    onClick={() => {
                      void (async () => {
                        const result = await postTasks({ op: 'scheduleDelete', sessionId: event.sessionId, scheduleId: event.scheduleId })
                        if (result === undefined) onError()
                      })()
                    }}
                  >
                    {t('cal.cancel')}
                  </button>
                  : null}
              </li>
            ))}
          </ul>}
      </div>
      <div className={css.calNew}>
        <h3 className={css.detailSectionTitle}>{t('cal.new')}</h3>
        {boardSessionId === undefined
          ? <p className={css.detailText}>{t('cal.newNoTarget')}</p>
          : <div className={css.calNewForm}>
            <span className={css.calNewHint}>{t('cal.newTarget')}</span>
            <input
              type="date"
              className={css.calNewDate}
              value={selectedDate}
              aria-label={t('cal.newDate')}
              onChange={(event) => { setSelectedDate(event.target.value) }}
            />
            <input
              type="time"
              className={css.calNewTime}
              value={time}
              aria-label={t('cal.newTime')}
              onChange={(event) => { setTime(event.target.value) }}
            />
            <input
              type="text"
              className={css.calNewPrompt}
              placeholder={t('cal.newPrompt')}
              value={prompt}
              onChange={(event) => { setPrompt(event.target.value) }}
            />
            <button
              type="button"
              className={css.calNewCreate}
              disabled={creating || prompt.trim() === ''}
              onClick={() => { void create() }}
            >
              {t('cal.newCreate')}
            </button>
          </div>}
      </div>
    </div>
  )
}

/** Overlay editor for one task record (or a new task), with a structured plan list. */
function TaskEditor({ task, onClose, onSaved, t }: { task: TaskRecord | undefined; onClose: () => void; onSaved: () => void; t: BoardViewProps['t'] }) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [purpose, setPurpose] = useState(task?.purpose ?? '')
  const [category, setCategory] = useState<'work' | 'learning'>(task?.category ?? 'work')
  const [plan, setPlan] = useState<PlanItem[]>(() => (task?.plan ?? []).map(item => ({ ...item })))
  const [progress, setProgress] = useState(task?.progress ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  const addPlanItem = (): void => {
    setPlan(current => [...current, {
      id: `pi-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      content: '',
      priority: 'medium',
      done: false,
    }])
  }
  const patchPlanItem = (id: string, patch: Partial<Omit<PlanItem, 'deadline'>> & { deadline?: string | undefined }): void => {
    setPlan(current => current.map(item => item.id === id ? { ...item, ...patch } : item))
  }
  const removePlanItem = (id: string): void => {
    setPlan(current => current.filter(item => item.id !== id))
  }
  const movePlanItem = (id: string, offset: -1 | 1): void => {
    setPlan((current) => {
      const index = current.findIndex(item => item.id === id)
      const target = index + offset
      if (index === -1 || target < 0 || target >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      if (moved === undefined) return current
      next.splice(target, 0, moved)
      return next
    })
  }

  const save = async (): Promise<void> => {
    if (title.trim() === '') return
    setSaving(true)
    try {
      const planPayload = plan
        .filter(item => item.content.trim() !== '')
        .map(({ content, priority, done: itemDone, deadline }) => ({
          content,
          priority,
          done: itemDone,
          ...(deadline === undefined || deadline === '' ? {} : { deadline }),
        }))
      await postTasks(task === undefined
        ? { op: 'create', title, purpose, category, plan: planPayload }
        : { op: 'update', taskId: task.id, title, purpose, category, plan: planPayload, progress })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return createPortal((
    <div className={css.prefsOverlay} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }}>
      <div className={css.prefsDialog} role="dialog" aria-modal="true" aria-label={t('task.edit')}>
        <h2 className={css.prefsHeading}>{task === undefined ? t('task.new') : `${t('task.edit')} · ${task.title}`}</h2>
        <label className={css.prefsField}>
          <span className={css.prefsFieldLabel}>{t('task.title')}</span>
          <input
            className={css.taskTitleInput}
            value={title}
            onChange={(event) => { setTitle(event.target.value) }}
          />
        </label>
        <div className={css.prefsField}>
          <span className={css.prefsFieldLabel}>{t('task.category')}</span>
          <div className={css.categoryPicker}>
            <button
              type="button"
              className={category === 'work' ? `${css.categoryOption} ${css.categoryOptionActive} ${css.categoryOptionWork}` : css.categoryOption}
              onClick={() => { setCategory('work') }}
            >
              {t('note.work')}
            </button>
            <button
              type="button"
              className={category === 'learning' ? `${css.categoryOption} ${css.categoryOptionActive} ${css.categoryOptionLearning}` : css.categoryOption}
              onClick={() => { setCategory('learning') }}
            >
              {t('note.learning')}
            </button>
          </div>
        </div>
        <label className={css.prefsField}>
          <span className={css.prefsFieldLabel}>{t('task.purpose')}</span>
          <textarea
            className={css.prefsTextarea} value={purpose} rows={4} spellCheck={false}
            onChange={(event) => { setPurpose(event.target.value) }}
          />
        </label>
        <div className={css.prefsField}>
          <span className={css.prefsFieldLabel}>{t('task.plan')}</span>
          <div className={css.planList}>
            {plan.length === 0
              ? <p className={css.planEmpty}>{t('plan.empty')}</p>
              : plan.map((item, index) => (
                <div key={item.id} className={css.planRow}>
                  <input
                    type="checkbox"
                    className={css.planCheck}
                    checked={item.done}
                    aria-label={t('task.plan')}
                    onChange={(event) => { patchPlanItem(item.id, { done: event.target.checked }) }}
                  />
                  <input
                    type="text"
                    className={css.planContent}
                    value={item.content}
                    placeholder={t('plan.itemContent')}
                    onChange={(event) => { patchPlanItem(item.id, { content: event.target.value }) }}
                  />
                  <select
                    className={css.planPrioritySelect}
                    value={item.priority}
                    aria-label={t('task.plan')}
                    onChange={(event) => { patchPlanItem(item.id, { priority: event.target.value as PlanItem['priority'] }) }}
                  >
                    <option value="high">{t('priority.high')}</option>
                    <option value="medium">{t('priority.medium')}</option>
                    <option value="low">{t('priority.low')}</option>
                  </select>
                  <input
                    type="date"
                    className={css.planDeadlineInput}
                    value={item.deadline ?? ''}
                    aria-label={t('plan.deadline')}
                    onChange={(event) => { patchPlanItem(item.id, { deadline: event.target.value === '' ? undefined : event.target.value }) }}
                  />
                  <button type="button" className={css.planBtn} disabled={index === 0} aria-label="up" onClick={() => { movePlanItem(item.id, -1) }}>↑</button>
                  <button type="button" className={css.planBtn} disabled={index === plan.length - 1} aria-label="down" onClick={() => { movePlanItem(item.id, 1) }}>↓</button>
                  <button type="button" className={css.planBtnDanger} aria-label="remove" onClick={() => { removePlanItem(item.id) }}>×</button>
                </div>
              ))}
            <button type="button" className={css.planAdd} onClick={addPlanItem}>{t('plan.add')}</button>
          </div>
        </div>
        {task !== undefined
          ? <label className={css.prefsField}>
            <span className={css.prefsFieldLabel}>{t('task.progress')}</span>
            <textarea
              className={css.prefsTextarea} value={progress} rows={6} spellCheck={false}
              onChange={(event) => { setProgress(event.target.value) }}
            />
          </label>
          : null}
        <div className={css.prefsActions}>
          <button type="button" className={css.prefsSecondary} onClick={onClose}>{t('task.cancel')}</button>
          <button type="button" className={css.prefsPrimary} disabled={saving || title.trim() === ''} onClick={() => { void save() }}>
            {t('task.save')}
          </button>
        </div>
      </div>
    </div>
  ), document.body)
}

/** Overlay editor for the two reply-style profile files. */
function PreferencesEditor({ onClose, t }: { onClose: () => void; t: BoardViewProps['t'] }) {
  const [work, setWork] = useState('')
  const [learning, setLearning] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const state = await fetchPreferences()
      if (cancelled || state === undefined) return
      setWork(state.work)
      setLearning(state.learning)
      setLoaded(true)
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await writeProfile('work', work)
      await writeProfile('learning', learning)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return createPortal((
    <div className={css.prefsOverlay} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }}>
      <div className={css.prefsDialog} role="dialog" aria-modal="true" aria-label={t('prefs.open')}>
        <h2 className={css.prefsHeading}>{t('prefs.open')}</h2>
        <p className={css.prefsHint}>{t('prefs.hint')}</p>
        <div className={css.prefsFields}>
          <label className={css.prefsField}>
            <span className={css.prefsFieldLabel}>{t('prefs.work')}</span>
            <textarea
              className={css.prefsTextarea} value={work} rows={12} spellCheck={false}
              onChange={(event) => { setWork(event.target.value) }}
            />
          </label>
          <label className={css.prefsField}>
            <span className={css.prefsFieldLabel}>{t('prefs.learning')}</span>
            <textarea
              className={css.prefsTextarea} value={learning} rows={12} spellCheck={false}
              onChange={(event) => { setLearning(event.target.value) }}
            />
          </label>
        </div>
        <div className={css.prefsActions}>
          <button type="button" className={css.prefsSecondary} onClick={onClose}>{t('prefs.cancel')}</button>
          <button type="button" className={css.prefsPrimary} disabled={!loaded || saving} onClick={() => { void save() }}>
            {t('prefs.save')}
          </button>
        </div>
      </div>
    </div>
  ), document.body)
}
