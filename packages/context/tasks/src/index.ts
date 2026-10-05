/**
 * First-class task records for the personal workbench: every task carries a
 * purpose, a plan, and a progress log. Every conversation belongs to exactly
 * one task (unassigned sessions fall back to the catch-all "其它" task), the
 * owner is announced as runtime context, and the model may only update the
 * task its conversation belongs to — switching ownership goes through
 * task_start.
 *
 * When a web server is composed, the plugin also serves a token-guarded
 * `/tasks` route (GET reads all tasks; POST performs create / update /
 * delete / newSession) and injects the per-process token into the page.
 *
 * @module @deepseek-ai/dsh-tasks
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Task lifecycle state. */
type TaskStatus = 'active' | 'done'

/** Priority of one plan item. */
type PlanPriority = 'high' | 'medium' | 'low'

/** Task category shown on the board and reserved for future preference wiring. */
type TaskCategory = 'work' | 'learning'

/** One structured plan item: content, priority, order (array order), done, optional closure date. */
export interface PlanItem {
  readonly id: string
  readonly content: string
  readonly priority: PlanPriority
  readonly done: boolean
  /** Optional closure (闭环) date, `YYYY-MM-DD`; shown on the calendar when present. */
  readonly deadline?: string
}

/** One task record; sessions reference ordinary conversation ids. */
export interface TaskRecord {
  readonly id: string
  readonly title: string
  readonly purpose: string
  readonly plan: readonly PlanItem[]
  readonly progress: string
  readonly status: TaskStatus
  /** Work or learning; drives the board badge and future reply-style wiring. */
  readonly category: TaskCategory
  /** Pinned tasks lead the board's sticky wall. */
  readonly pinned?: boolean | undefined
  readonly createdAt: number
  readonly updatedAt: number
  readonly sessions: string[]
}

/** Plugin config. */
export interface Config {
  /** Directory holding the task store (default `$DSH_HOME/tasks`). */
  dir?: string
}

export const name = 'tasks'
// The agent registry is reached structurally inside the route handler, so the
// inject list stays identical to the preferences precedent.
export const inject = ['systemPrompt', 'tools']
export const Config = z.object({
  dir: z.string(),
})

function tasksPath(dir: string): string {
  return join(dir, 'tasks.json')
}

/**
 * Fixed id of the catch-all task: every conversation MUST belong to a task,
 * and sessions nobody assigned land here instead of floating unowned.
 */
export const DEFAULT_TASK_ID = 'task-misc'

/** Build the catch-all task record shown when no task was ever assigned. */
function defaultTaskRecord(): TaskRecord {
  const now = Date.now()
  return {
    id: DEFAULT_TASK_ID,
    title: '其它',
    purpose: [
      '没有归入具体任务的对话与工作都记录在这个任务下。',
      '用户没有明确指定任务时，本任务就是当前工作的记录处：计划、进展都用 task_update 写在这里。',
      '只有当用户明确要求开一个全新的任务时才调用 task_create，创建后用 task_start 把会话切换过去。',
    ].join('\n'),
    plan: [],
    progress: '',
    status: 'active',
    category: 'work',
    createdAt: now,
    updatedAt: now,
    sessions: [],
  }
}

/**
 * The one task a session currently belongs to: an explicit assignment wins;
 * an unassigned session falls back to the catch-all task, so every
 * conversation always reports a current task.
 */
function currentTaskFor(tasks: readonly TaskRecord[], sessionId: string): TaskRecord | undefined {
  return tasks.find(task => task.sessions.includes(sessionId))
    ?? tasks.find(task => task.id === DEFAULT_TASK_ID)
}

function emptyRecord(
  title: string,
  purpose: string,
  plan: readonly PlanItem[],
  category: TaskCategory,
): TaskRecord {
  const now = Date.now()
  return {
    id: `task-${randomUUID().slice(0, 8)}`,
    title,
    purpose,
    plan,
    progress: '',
    status: 'active',
    category,
    createdAt: now,
    updatedAt: now,
    sessions: [],
  }
}

/** Valid closure date: `YYYY-MM-DD`. */
const DEADLINE_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Coerce one raw value into a plan item; malformed entries are dropped. */
function normalizePlanItem(value: unknown): PlanItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { id?: unknown; content?: unknown; priority?: unknown; done?: unknown; deadline?: unknown }
  if (typeof raw.content !== 'string' || raw.content.trim() === '') return undefined
  const deadline = typeof raw.deadline === 'string' && DEADLINE_DATE.test(raw.deadline) ? raw.deadline : undefined
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `pi-${randomUUID().slice(0, 6)}`,
    content: raw.content,
    priority: raw.priority === 'high' || raw.priority === 'low' ? raw.priority : 'medium',
    done: raw.done === true,
    ...(deadline === undefined ? {} : { deadline }),
  }
}

/** Normalize a plan value: a legacy Markdown string becomes an empty list. */
function normalizePlan(value: unknown): readonly PlanItem[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizePlanItem).filter((item): item is PlanItem => item !== undefined)
}

function isRecord(value: unknown): value is TaskRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  // The plan may be a legacy Markdown string; normalizePlan migrates it.
  return typeof record.id === 'string' && typeof record.title === 'string'
    && typeof record.purpose === 'string' && (typeof record.plan === 'string' || Array.isArray(record.plan))
    && typeof record.progress === 'string' && (record.status === 'active' || record.status === 'done')
    && typeof record.createdAt === 'number' && typeof record.updatedAt === 'number'
    && Array.isArray(record.sessions) && record.sessions.every(id => typeof id === 'string')
}

/** Migrate one validated record: legacy tasks without a category default to work. */
function migrateRecord(record: TaskRecord): TaskRecord {
  const category = record.category === 'work' || record.category === 'learning' ? record.category : 'work'
  return category === record.category && (record.pinned === undefined || typeof record.pinned === 'boolean')
    ? record
    : { ...record, category, pinned: record.pinned === true ? true : undefined }
}

/** Read the task list; a missing or malformed file means no tasks. */
function readTasks(dir: string): TaskRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(tasksPath(dir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { tasks?: unknown }).tasks)) return []
    return ((parsed as { tasks: unknown[] }).tasks)
      .filter(isRecord)
      .map(record => migrateRecord({ ...record, plan: normalizePlan(record.plan) }))
  } catch {
    return []
  }
}

function writeTasks(dir: string, tasks: TaskRecord[]): void {
  writeFileSync(tasksPath(dir), `${JSON.stringify({ tasks }, null, 2)}\n`)
}

/** Render the model-facing briefing for one attached task. */
function renderBriefing(task: TaskRecord): string {
  const planBlock = task.plan.length === 0
    ? ''
    : `<plan>\n${task.plan.map((item) => {
      const deadline = item.deadline === undefined ? '' : ` (deadline ${item.deadline})`
      return `- ${item.done ? '[x]' : '[ ]'} (${item.priority})${deadline} ${item.content}`
    }).join('\n')}\n</plan>`
  return [
    `Current task for this conversation: "${task.title}" (${task.id}, status: ${task.status}, category: ${task.category}).`,
    `This conversation BELONGS to task ${task.id} and to no other task. You may ONLY maintain THIS task: call task_update with taskId ${task.id} for its plan and progress. NEVER call task_create in this conversation — work done here is recorded on ${task.id} even when it looks like a new piece of work (including "make a plan for X": that plan goes into ${task.id}'s plan). Only when the user EXPLICITLY demands a brand-new unrelated task may you create one, and you must then call task_start to switch this conversation to it.`,
    'Task updates are user-reviewed: task_update shows the before/after diff to the user first; if they decline with feedback, adjust according to their notes and call task_update again.',
    '',
    `<task id="${task.id}">`,
    `<purpose>\n${task.purpose}\n</purpose>`,
    planBlock,
    task.progress === '' ? '' : `<progress>\n${task.progress}\n</progress>`,
    '</task>',
  ].filter(part => part !== '').join('\n')
}

/** Mutable mirror of TaskRecord for in-place field updates. */
type WritableTask = { -readonly [K in keyof TaskRecord]: TaskRecord[K] }

/** Structural view of the user-questions channel used for update review. */
interface UserQuestionsLike {
  ask(request: {
    questions: readonly {
      id: string
      question: string
      detail?: string
      header?: string
      options?: readonly { label: string; description?: string }[]
    }[]
    agent?: unknown
    signal?: AbortSignal | undefined
  }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>
}

/** Answer labels for the task-update review question. */
const APPLY_LABEL = '应用更新'
const REVISE_LABEL = '退回修改'

/** Render one task's identity line for the review diff. */
function renderTaskLine(task: TaskRecord): string {
  const plan = task.plan.map((item) => {
    const deadline = item.deadline === undefined ? '' : `（闭环 ${item.deadline}）`
    return `  - [${item.done ? 'x' : ' '}] (${item.priority})${deadline} ${item.content}`
  }).join('\n')
  return [
    `标题：${task.title}`,
    `类型：${task.category === 'learning' ? '学习' : '工作'}`,
    `状态：${task.status}`,
    `目的：\n${task.purpose.trim() === '' ? '（空）' : task.purpose}`,
    `计划：\n${plan === '' ? '（空）' : plan}`,
    `进展：\n${task.progress.trim() === '' ? '（空）' : task.progress}`,
  ].join('\n')
}

/**
 * Render the before/after review diff shown to the user when the model calls
 * task_update. Only fields the update actually touches are listed as changes;
 * both full records follow so the user sees the whole picture either way.
 */
function renderUpdateDiff(before: TaskRecord, after: TaskRecord): string {
  const fields: readonly [label: string, key: keyof TaskRecord][] = [
    ['标题', 'title'],
    ['类型', 'category'],
    ['状态', 'status'],
    ['目的', 'purpose'],
    ['计划', 'plan'],
    ['进展', 'progress'],
  ]
  const changed = fields.filter(([, key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(([label]) => label)
  return [
    `本次修改的字段：${changed.length === 0 ? '（无实质变化）' : changed.join('、')}`,
    '',
    '### 修改前',
    renderTaskLine(before),
    '',
    '### 修改后',
    renderTaskLine(after),
    '',
    '以上为完整任务记录；顶部列出了本次实际变化的字段。',
  ].join('\n')
}

/**
 * Cap on how long the task-update review waits for the user. userQuestions
 * has no built-in timeout: a request claimed by a client but not visible in
 * any mounted panel would otherwise stall the turn (and the running
 * indicator) until some teardown event returns it.
 */
const REVIEW_ASK_TIMEOUT_MS = 180_000

/**
 * Ask the user to review one task update before it is written: approve
 * applies it, anything else (or free-text feedback) returns the user's notes
 * so the model can adjust and call task_update again.
 * @returns true when the user approved writing the update.
 */
async function reviewTaskUpdate(
  ctx: Context,
  before: TaskRecord,
  after: TaskRecord,
  agent: unknown,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const interaction = (ctx as unknown as { get?: (name: string) => unknown }).get?.('userQuestions') as UserQuestionsLike | undefined
  if (interaction === undefined) {
    throw new Error('no user-questions channel is available to review the task update; ask the user to confirm the change in chat instead')
  }
  const timeout = AbortSignal.timeout(REVIEW_ASK_TIMEOUT_MS)
  const askSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let answer: Awaited<ReturnType<UserQuestionsLike['ask']>>
  try {
    answer = await interaction.ask({
      questions: [{
        id: 'task-update-review',
        header: '任务更新审核',
        question: `模型请求更新任务「${before.title}」，应用这次修改吗？`,
        detail: renderUpdateDiff(before, after),
        options: [
          { label: APPLY_LABEL, description: '按「修改后」写入任务记录。' },
          { label: REVISE_LABEL, description: '不写入；在输入框写下意见，模型会按意见调整后重新提交。' },
        ],
      }],
      agent,
      signal: askSignal,
    })
  } catch (cause: unknown) {
    const code = (cause as { code?: unknown }).code
    if (code === 'ASK_CANCELLED') {
      throw new Error('The user dismissed the task-update review to speak instead; stop here and wait for their message.')
    }
    if (timeout.aborted) {
      throw new Error('The task-update review timed out after 3 minutes without an answer; the update was NOT applied. Do not retry immediately: tell the user in chat what you wanted to change and retry task_update only after they confirm.')
    }
    if (code === 'NO_PROVIDER') {
      throw new Error('The task-update review could not reach a visible conversation panel; the update was NOT applied. Tell the user in chat what you wanted to change and retry task_update only after they confirm.')
    }
    throw cause
  }
  const item = answer.answers.find(entry => entry.id === 'task-update-review')
  if (item !== undefined && item.selected.length === 1 && item.selected[0] === APPLY_LABEL && item.custom === undefined) {
    return true
  }
  const feedback = item?.custom ?? ''
  throw new Error(feedback === ''
    ? 'The user declined the task update; revise it according to their earlier notes and call task_update again.'
    : `The user declined the task update; their feedback: ${feedback}`)
}

/** Structural view of the agent registry and session titler this plugin uses. */
interface AgentsLike {
  create(options: { sessionId?: string; signal?: AbortSignal; meta?: { cwd?: string } }): Promise<{
    dispose(): Promise<void>
    agent: { session: { id: string } }
  }>
  /** Live agent for a session id, or undefined when the session is cold. */
  get(sessionId: string): unknown | undefined
  /** Rebuild a persisted session's agent; the handle stays alive afterwards. */
  resume(options: { resumeSessionId: string }): Promise<{ agent: unknown }>
}

/** Structural view of the host schedule service this plugin uses (0.2.1's
 * global schedule: create/delete take a sessionId directly, no live agent). */
interface ScheduleLike {
  create(sessionId: string, request: {
    prompt: string
    title: string
    at?: string
    after_seconds?: number
    every_seconds?: number
  }, signal?: AbortSignal): Promise<unknown>
  delete(request: { sessionId: string; id: string }, signal?: AbortSignal): Promise<{ deleted: boolean }>
}

/**
 * Structural view of the workspace registry this plugin uses: the newSession
 * operation attaches the conversation to the requesting browser's workspace so
 * the client directory can actually see it.
 */
interface WorkspaceRegistryLike {
  create(path: string): Promise<{
    readonly path: string
    attachSession(sessionId: string): Promise<void>
    detachSession(sessionId: string): Promise<void>
  }>
}

/** Structural view of the live session registry used for cwd resolution. */
interface SessionsLike {
  list(): { header: { cwd: string; createdAt: number } }[]
}

/**
 * Resolve the workspace path a new task conversation should live in: the
 * browser's explicit cwd wins; otherwise the newest live session's cwd (the
 * browser keeps its current session live, so that is where it is looking);
 * the process cwd is the last resort.
 */
function resolveNewSessionCwd(payload: Record<string, unknown>, sessions: SessionsLike | undefined): string {
  const requested = payload.cwd
  if (typeof requested === 'string' && requested.trim() !== '') return requested.trim()
  if (sessions !== undefined) {
    const headers = sessions.list().map(session => session.header).filter(header => typeof header.cwd === 'string')
    if (headers.length > 0) return headers.reduce((a, b) => a.createdAt >= b.createdAt ? a : b).cwd
  }
  return process.cwd()
}

/** Structural view of the webserver capabilities this plugin consumes. */
interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  tapIndex(transform: (html: string) => string): () => void
}

const TASK_FIELDS = ['title', 'purpose', 'progress'] as const

/** Serve the token-guarded `/tasks` route on a composed web server. */
function serveTasksApi(scope: Context, dir: string): void {
  try {
    const webServer = (scope as unknown as { webServer?: WebServerLike }).webServer
    if (webServer === undefined) {
      console.error('[dsh-tasks] webServer service unavailable in scope; route not served')
      return
    }
    const agents = (scope as unknown as { agents?: AgentsLike }).agents
    const workspaceRegistry = (scope as unknown as { workspaceRegistry?: WorkspaceRegistryLike }).workspaceRegistry
    const schedule = (scope as unknown as { schedule?: ScheduleLike }).schedule
    const sessions = (scope as unknown as { sessions?: SessionsLike }).sessions
    const sessionTitle = (scope as unknown as { sessionTitle?: { rename(session: unknown, title: string): void } }).sessionTitle
    const token = randomUUID()
    const disposeTap = webServer.tapIndex(html =>
      html.replace('</head>', `<meta name="dsh-tasks" content="${token}"></head>`))
    const json = (res: ServerResponse, status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const disposeRoute = webServer.register({
      kind: 'exact',
      path: '/tasks',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.searchParams.get('token') !== token) {
          json(res, 401, { ok: false })
          return
        }
        if (req.method === 'GET') {
          json(res, 200, { tasks: readTasks(dir) })
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false })
          return
        }
        let body = ''
        for await (const chunk of req) body += chunk
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(body) as Record<string, unknown>
        } catch {
          json(res, 400, { ok: false })
          return
        }
        const tasks = readTasks(dir)
        const findTask = (id: unknown): TaskRecord | undefined =>
          typeof id === 'string' ? tasks.find(task => task.id === id) : undefined
        try {
          if (payload.op === 'create' && typeof payload.title === 'string' && payload.title.trim() !== '') {
            const record = emptyRecord(payload.title.trim().slice(0, 120),
              typeof payload.purpose === 'string' ? payload.purpose : '',
              normalizePlan(payload.plan),
              payload.category === 'learning' ? 'learning' : 'work')
            tasks.unshift(record)
            writeTasks(dir, tasks)
            json(res, 200, { ok: true, task: record })
            return
          }
          const task = findTask(payload.taskId)
          if (payload.op === 'update' && task !== undefined) {
            const next: WritableTask = { ...task, updatedAt: Date.now() }
            for (const field of TASK_FIELDS) {
              const value = payload[field]
              if (typeof value === 'string') next[field] = value
            }
            if (payload.category === 'work' || payload.category === 'learning') next.category = payload.category
            if (payload.pinned === true) next.pinned = true
            else if (payload.pinned === false) next.pinned = undefined
            if (Array.isArray(payload.plan)) next.plan = normalizePlan(payload.plan)
            if (payload.status === 'active' || payload.status === 'done') next.status = payload.status
            tasks.splice(tasks.indexOf(task), 1, next)
            writeTasks(dir, tasks)
            json(res, 200, { ok: true, task: next })
            return
          }
          if (payload.op === 'delete' && task !== undefined) {
            if (task.id === DEFAULT_TASK_ID) {
              json(res, 400, { ok: false, error: 'the catch-all task cannot be deleted' })
              return
            }
            tasks.splice(tasks.indexOf(task), 1)
            writeTasks(dir, tasks)
            json(res, 200, { ok: true })
            return
          }
          if (payload.op === 'newSession' && task !== undefined && agents !== undefined && workspaceRegistry !== undefined) {
          // The browser sends its current workspace path; the newest live
          // session's cwd backs it up, and without either the server cwd
          // would file the conversation under an invisible workspace.
            const cwd = resolveNewSessionCwd(payload, sessions)
            const workspace = await workspaceRegistry.create(cwd)
            const sessionId = `task-${randomUUID()}`
            const handle = await agents.create({ sessionId, signal: new AbortController().signal, meta: { cwd: workspace.path } })
            let attached = false
            try {
            // Attach before answering: membership is what makes the session
            // visible (and openable) in the requesting browser.
              await workspace.attachSession(sessionId)
              attached = true
              sessionTitle?.rename(handle.agent.session, `${task.title} · 会话`)
            } catch (error: unknown) {
              if (attached) {
                try {
                  await workspace.detachSession(sessionId)
                } catch {
                // A failed rollback must not mask the original failure.
                }
              }
              throw error
            }
            const next: TaskRecord = { ...task, updatedAt: Date.now(), sessions: [...task.sessions, handle.agent.session.id] }
            tasks.splice(tasks.indexOf(task), 1, next)
            writeTasks(dir, tasks)
            json(res, 200, { ok: true, sessionId: handle.agent.session.id })
            return
          }
          if (payload.op === 'attachSession' && task !== undefined && typeof payload.sessionId === 'string') {
          // Idempotent: attaching an already-member session is a no-op, so a
          // client re-handling a fork child never duplicates membership.
            if (!task.sessions.includes(payload.sessionId)) {
              const next: TaskRecord = { ...task, updatedAt: Date.now(), sessions: [...task.sessions, payload.sessionId] }
              tasks.splice(tasks.indexOf(task), 1, next)
              writeTasks(dir, tasks)
            }
            json(res, 200, { ok: true })
            return
          }
          if (payload.op === 'detach' && task !== undefined && typeof payload.sessionId === 'string') {
            const next: TaskRecord = { ...task, updatedAt: Date.now(), sessions: task.sessions.filter(id => id !== payload.sessionId) }
            tasks.splice(tasks.indexOf(task), 1, next)
            writeTasks(dir, tasks)
            json(res, 200, { ok: true })
            return
          }
          // Calendar management: create and remove reminders on a session
          // through the host's global schedule service.
          if (payload.op === 'scheduleCreate' && schedule !== undefined
          && typeof payload.sessionId === 'string' && typeof payload.prompt === 'string' && payload.prompt.trim() !== '') {
            const record = await schedule.create(payload.sessionId, {
              prompt: payload.prompt,
              title: payload.prompt.trim().slice(0, 120),
              ...(typeof payload.at === 'string' ? { at: payload.at } : {}),
              ...(typeof payload.afterSeconds === 'number' ? { after_seconds: payload.afterSeconds } : {}),
              ...(typeof payload.everySeconds === 'number' ? { every_seconds: payload.everySeconds } : {}),
            })
            json(res, 200, { ok: true, schedule: record })
            return
          }
          if (payload.op === 'scheduleDelete' && schedule !== undefined
          && typeof payload.sessionId === 'string' && typeof payload.scheduleId === 'string') {
            const result = await schedule.delete({ sessionId: payload.sessionId, id: payload.scheduleId })
            json(res, 200, { ok: true, deleted: result.deleted })
            return
          }
        } catch (error: unknown) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'task op failed' })
          return
        }
        json(res, 400, { ok: false })
      },
    })
    scope.effect(() => () => {
      disposeRoute()
      disposeTap()
    }, 'tasks: web route')
  } catch (error: unknown) {
    console.error('[dsh-tasks] route setup failed:', error)
  }
}

export function apply(ctx: Context, config: Config): void {
  const dir = config.dir ?? dshHomePath('tasks')
  mkdirSync(dir, { recursive: true })

  // Every conversation must belong to a task: ensure the catch-all task
  // exists so unassigned sessions always have an owner.
  {
    const tasks = readTasks(dir)
    if (!tasks.some(task => task.id === DEFAULT_TASK_ID)) {
      tasks.push(defaultTaskRecord())
      writeTasks(dir, tasks)
    }
  }

  // Cordis contexts are proxies: reading a service property requires the
  // service to be declared here, so the route scope injects everything it
  // touches (webServer, agents, workspaceRegistry, schedule, sessions,
  // sessionTitle are all composed in the web profile: web-app layer, base's
  // schedule row, and base's core/agent + workspace + session-title).
  ctx.inject(['webServer', 'agents', 'workspaceRegistry', 'schedule', 'sessions', 'sessionTitle'], (scope: Context) => { serveTasksApi(scope, dir) })

  ctx.systemPrompt.context({
    name: 'tasks:briefing',
    order: 126,
    text: (context) => {
      const session = context.agent?.session
      if (session === undefined) return ''
      // Unassigned sessions report the catch-all task: the model always
      // knows which task it belongs to and never needs task_create.
      const task = currentTaskFor(readTasks(dir), session.id)
      if (task === undefined) return ''
      const briefing = renderBriefing(task)
      return briefing === '' ? '' : briefing
    },
  })

  ctx.tools.register(defineTool({
    name: 'task_create',
    description: 'Create a first-class task record for the personal workbench task board. Call it ONLY when the user explicitly demands a brand-new unrelated task ("新建任务/开个新任务：…"). Every conversation already belongs to a task (see the runtime-context task briefing) — for work in this conversation, including making or refreshing a plan, update that task with task_update instead of creating another one. Creating a task does NOT move this conversation to it; call task_start to switch.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short task title (one line).' },
      purpose: { type: 'string', description: 'Why the task exists and what "done" means; Markdown.' },
      category: { type: 'string', enum: ['work', 'learning'], description: 'Task category shown on the board: work (default) or learning.' },
      plan: {
        type: 'array',
        description: 'Initial plan items in execution order; array order is the order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'One plan step — a short imperative line.' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high | medium (default) | low.' },
            deadline: { type: 'string', description: 'Optional closure date, YYYY-MM-DD; shown on the calendar.' },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { task: { type: 'string', required: true }, note: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Task created:\n\n${value.task}${value.note === undefined ? '' : `\n\n${value.note}`}` }],
    },
    async execute(args, exec) {
      const tasks = readTasks(dir)
      const record = emptyRecord(
        args.title.trim().slice(0, 120),
        args.purpose ?? '',
        normalizePlan(args.plan),
        args.category === 'learning' ? 'learning' : 'work',
      )
      tasks.unshift(record)
      writeTasks(dir, tasks)
      // This conversation's owner does not change on create: say so, so the
      // model keeps recording work where it belongs.
      const session = exec.agent?.session
      const current = session === undefined ? undefined : currentTaskFor(readTasks(dir), session.id)
      const note = current === undefined || current.id === record.id ? undefined
        : `Note: this conversation still belongs to task "${current.title}" (${current.id}); the new task is NOT attached here. Keep recording this conversation's work on ${current.id}, or call task_start to switch this conversation to the new task.`
      return { task: JSON.stringify(record, null, 2), ...note === undefined ? {} : { note } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_update',
    description: 'Update the task this conversation belongs to (title, purpose, category, plan items, progress, status). The runtime-context task briefing names that task and its id; a conversation may ONLY update its own current task — updating any other task id fails. Every update is USER-REVIEWED: the user sees the before/after diff first and may decline with feedback; when declined, adjust according to their notes and call task_update again with the revised fields. Call it whenever meaningful work happens: rewrite "progress" as a dated changelog entry list, adjust plan items when the approach changes (send the COMPLETE new list; array order is execution order), and set status "done" when the purpose is met. Only provided fields change.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'The task id (task-…) — must be the current task from the runtime-context briefing.' },
      title: { type: 'string', description: 'New title.' },
      purpose: { type: 'string', description: 'New purpose (replaces the old one).' },
      category: { type: 'string', enum: ['work', 'learning'], description: 'Task category shown on the board.' },
      plan: {
        type: 'array',
        description: 'The COMPLETE new plan, replacing the old one; array order is execution order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'One plan step.' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high | medium (default) | low.' },
            done: { type: 'boolean', description: 'Whether this item is complete.' },
            deadline: { type: 'string', description: 'Optional closure date, YYYY-MM-DD; shown on the calendar.' },
          },
        },
      },
      progress: { type: 'string', description: 'New progress log (replaces the old one); keep dated entries, newest last.' },
      status: { type: 'string', enum: ['active', 'done'], description: 'Task lifecycle state.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { task: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Task updated (user approved):\n\n${value.task}` }],
    },
    async execute(args, exec) {
      const tasks = readTasks(dir)
      // Single-membership enforcement: a conversation may only update the
      // task it currently belongs to (unassigned sessions own the catch-all).
      const session = exec.agent?.session
      if (session !== undefined) {
        const current = currentTaskFor(tasks, session.id)
        if (current !== undefined && args.taskId !== current.id) {
          throw new Error(`this conversation belongs to task "${current.title}" (${current.id}); it can only update that task here — call task_start with the target task id first to switch this conversation`)
        }
      }
      const before = tasks.find(task => task.id === args.taskId)
      if (before === undefined) throw new Error(`unknown task: ${args.taskId}`)
      const next: WritableTask = { ...before, updatedAt: Date.now() }
      for (const field of TASK_FIELDS) {
        const value = args[field]
        if (typeof value === 'string') next[field] = value
      }
      if (args.category === 'work' || args.category === 'learning') next.category = args.category
      if (Array.isArray(args.plan)) next.plan = normalizePlan(args.plan)
      if (args.status === 'active' || args.status === 'done') next.status = args.status
      // User review gate: only a conversation-driven update (live agent) asks;
      // programmatic callers (none today) would apply directly.
      if (exec.agent !== undefined) {
        await reviewTaskUpdate(ctx, before, next, exec.agent, exec.signal)
      }
      tasks.splice(tasks.indexOf(before), 1, next)
      writeTasks(dir, tasks)
      return { task: JSON.stringify(next, null, 2) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_start',
    description: 'Switch this conversation to an existing task (single membership: it is removed from the task it belonged to). Call it when the user explicitly moves on to a known task ("处理任务X / 继续任务X / 切到扫雷任务"), or right after task_create when the user demanded a brand-new task. The new task briefing is injected as runtime context for every following request.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'The task id (task-…).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { task: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Task attached. Briefing:\n\n${value.task}` }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('task_start requires an agent session')
      const tasks = readTasks(dir)
      const index = tasks.findIndex(task => task.id === args.taskId)
      if (index === -1) throw new Error(`unknown task: ${args.taskId}`)
      // Switch semantics: the session joins the target task and leaves every
      // other task, so a conversation always belongs to exactly one task.
      let changed = false
      const next = tasks.map((task) => {
        if (task.id === args.taskId) {
          if (task.sessions.includes(session.id)) return task
          changed = true
          return { ...task, updatedAt: Date.now(), sessions: [...task.sessions, session.id] }
        }
        if (!task.sessions.includes(session.id)) return task
        changed = true
        return { ...task, updatedAt: Date.now(), sessions: task.sessions.filter(id => id !== session.id) }
      })
      if (changed) writeTasks(dir, next)
      const target = next.find(task => task.id === args.taskId)
      if (target === undefined) throw new Error(`unknown task: ${args.taskId}`)
      return { task: renderBriefing(target) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_list',
    description: 'List every task record with its attached conversations. Use it to look up a task id before task_start (switching this conversation) — task_update only accepts the task this conversation currently belongs to.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { tasks: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.tasks }],
    },
    async execute() {
      return { tasks: JSON.stringify(readTasks(dir), null, 2) }
    },
  }))
}
