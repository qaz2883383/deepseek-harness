/**
 * Per-conversation reply-style preferences: a category selection (work or
 * learning) plus user-editable profile files, injected as runtime context.
 *
 * Personal workbench package: mounts in the web composition through the
 * web-app bundle row `preferences`. When a web server is composed, the
 * plugin also serves a token-guarded `/preferences` route (GET reads the
 * profiles and selections; POST writes one profile or one selection) and
 * injects the per-process token into the page as a meta element.
 *
 * @module @deepseek-ai/dsh-preferences
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** One selectable preference category; also the profile file name. */
type Category = 'work' | 'learning'

/** Plugin config. */
export interface Config {
  /** Directory holding profile files and selection state (default `$DSH_HOME/preferences`). */
  dir?: string
}

export const name = 'preferences'
export const inject = ['systemPrompt', 'tools']
export const Config = z.object({
  dir: z.string(),
})

const DEFAULT_PROFILES: Record<Category, string> = {
  work: [
    '# 工作任务回复偏好',
    '',
    '- 先给结论和行动项，细节放后面',
    '- 默认中文，技术名词保留英文',
    '- 单条回复尽量简短，除非我要求展开',
    '- 涉及决策时列出选项和推荐',
    '',
  ].join('\n'),
  learning: [
    '# 学习任务回复偏好',
    '',
    '- 给出完整推导过程，不要跳步',
    '- 引用来源或给出可验证的参考',
    '- 允许长回复，用小标题和列表组织',
    '- 主动指出常见误区',
    '',
  ].join('\n'),
}

function selectionPath(dir: string): string {
  return join(dir, 'selection.json')
}

function profilePath(dir: string, category: Category): string {
  return join(dir, `${category}.md`)
}

/** Read the selection map; a missing or malformed file means no selections. */
function readSelections(dir: string): Record<string, Category> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(selectionPath(dir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const selections: Record<string, Category> = {}
    for (const [sessionId, category] of Object.entries(parsed as Record<string, unknown>)) {
      if (category === 'work' || category === 'learning') selections[sessionId] = category
    }
    return selections
  } catch {
    return {}
  }
}

function writeSelections(dir: string, selections: Record<string, Category>): void {
  writeFileSync(selectionPath(dir), `${JSON.stringify(selections, null, 2)}\n`)
}

/** Read one profile file; a missing file falls back to the built-in default. */
function readProfile(dir: string, category: Category): string {
  try {
    return readFileSync(profilePath(dir, category), 'utf8')
  } catch {
    return DEFAULT_PROFILES[category]
  }
}

function isCategory(value: unknown): value is Category {
  return value === 'work' || value === 'learning'
}

/** Structural view of the webserver capabilities this plugin consumes. */
interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  tapIndex(transform: (html: string) => string): () => void
}

/** Serve the token-guarded `/preferences` route on a composed web server. */
function servePreferencesApi(scope: Context, dir: string): void {
  const webServer = (scope as { webServer?: WebServerLike }).webServer
  if (webServer === undefined) return
  // One token per process: the meta element reaches the served page, and the
  // route answers only requests carrying the same value as a query parameter.
  const token = randomUUID()
  const disposeTap = webServer.tapIndex(html =>
    html.replace('</head>', `<meta name="dsh-preferences" content="${token}"></head>`))
  const unauthorized = (res: ServerResponse): void => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"ok":false}')
  }
  const disposeRoute = webServer.register({
    kind: 'exact',
    path: '/preferences',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('token') !== token) {
        unauthorized(res)
        return
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          work: readProfile(dir, 'work'),
          learning: readProfile(dir, 'learning'),
          selections: readSelections(dir),
        }))
        return
      }
      if (req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        try {
          const payload = JSON.parse(body) as {
            op?: unknown
            category?: unknown
            content?: unknown
            sessionId?: unknown
          }
          if (payload.op === 'setProfile' && isCategory(payload.category) && typeof payload.content === 'string') {
            writeFileSync(profilePath(dir, payload.category), payload.content)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{"ok":true}')
            return
          }
          if (payload.op === 'setSelection' && typeof payload.sessionId === 'string'
            && (payload.category === null || isCategory(payload.category))) {
            const selections = readSelections(dir)
            const next: Record<string, Category> = payload.category === null
              ? Object.fromEntries(Object.entries(selections).filter(([id]) => id !== payload.sessionId))
              : { ...selections, [payload.sessionId]: payload.category }
            writeSelections(dir, next)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{"ok":true}')
            return
          }
        } catch {
          // Fall through to the bad-request answer.
        }
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{"ok":false}')
        return
      }
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end('{"ok":false}')
    },
  })
  scope.effect(() => () => {
    disposeRoute()
    disposeTap()
  }, 'preferences: web route')
}

export function apply(ctx: Context, config: Config): void {
  const dir = config.dir ?? dshHomePath('preferences')
  mkdirSync(dir, { recursive: true })
  for (const category of Object.keys(DEFAULT_PROFILES) as Category[]) {
    try {
      readFileSync(profilePath(dir, category))
    } catch {
      writeFileSync(profilePath(dir, category), DEFAULT_PROFILES[category])
    }
  }

  // The web route exists only when a web server is composed (the web
  // profile); headless and SDK compositions keep tools and context only.
  ctx.inject(['webServer'], (scope: Context) => { servePreferencesApi(scope, dir) })

  ctx.systemPrompt.context({
    name: 'preferences:profile',
    order: 125,
    text: (context) => {
      const session = context.agent?.session
      if (session === undefined) return ''
      const category = readSelections(dir)[session.id]
      if (category === undefined) return ''
      const profile = readProfile(dir, category).trim()
      if (profile.length === 0) return ''
      return `Current reply-style preference for this conversation: ${category}. Follow the standing instructions below when writing replies.\n\n<reply_style category="${category}">\n${profile}\n</reply_style>`
    },
  })

  ctx.tools.register(defineTool({
    name: 'reply_style',
    description: "Set this conversation's reply-style preference (work or learning); the selected profile is injected as runtime context for all following replies. Call it when the user asks for a different reply style, names a task category, or references a standing preference such as “按学习风格回答”.",
    parameters: {
      category: {
        type: 'string',
        enum: ['work', 'learning'],
        required: true,
        description: 'The preference category to select for this conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string', required: true },
          profile: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Reply style set to "${value.category}". The profile below now applies to replies in this conversation:\n\n${value.profile}`,
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('reply_style requires an agent session')
      const selections = readSelections(dir)
      selections[session.id] = args.category
      writeSelections(dir, selections)
      return { category: args.category, profile: readProfile(dir, args.category) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_preference',
    description: 'Append one standing instruction to a reply-style profile file (work or learning). Use when the user states a durable style preference, for example “以后工作类的回复都简短点”. The instruction takes effect from the next reply on.',
    parameters: {
      category: {
        type: 'string',
        enum: ['work', 'learning'],
        required: true,
        description: 'The profile file to append to.',
      },
      instruction: {
        type: 'string',
        required: true,
        description: 'One directive sentence, phrased as a standing instruction.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, _value) => [{
        type: 'text',
        text: 'Preference recorded; it applies from the next reply on.',
      }],
    },
    async execute(args) {
      const current = readProfile(dir, args.category)
      writeFileSync(profilePath(dir, args.category), `${current.trim()}\n- ${args.instruction}\n`)
      return { ok: true }
    },
  }))
}
