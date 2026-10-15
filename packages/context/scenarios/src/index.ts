/**
 * Scenario orchestration for the personal workbench: stage records injected
 * as runtime context (P1) plus the P2.1 stage-agent engine — on `turn/end`
 * the engine runs each `agent` stage whose trigger config matches, mounts a
 * dedicated child agent, harvests its final assistant output, and feeds it
 * back into the parent conversation as a `scenario-hook` notice.
 *
 * Stage model: one scenario carries an ordered `stages` array; `discipline`
 * stages inject verbatim text, `agent` stages carry `when` (trigger) + `run`
 * (instruction / preset / maxRuns), `gate` (P2.2) and `persist` (P2.3) are
 * declared but not yet driven. Records without `stages` synthesize the P1
 * fixed pipeline from the legacy fields, so existing stores keep working.
 *
 * The per-session trigger bookkeeping (finished turns, per-hook run counts)
 * lives in `state.json` next to the store and survives restarts.
 *
 * @module @deepseek-ai/dsh-scenarios
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { exec } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Notice fed back into a conversation by the scenario stage engine. */
    'scenario-hook': { kind: 'scenario-hook' } & import('@deepseek-ai/dsh-llm').ContextFormed
  }
}

/** Trigger primitives every hook-bearing stage can configure. */
export interface StageWhen {
  readonly on: 'turn_end' | 'idle' | 'explicit' | 'stage_enter'
  /** For `turn_end`: fire after the Nth finished turn; absent means every turn. */
  readonly turnIndex?: number
}

/** Execution payload of one `agent` stage. */
export interface StageRun {
  /** The instruction the dedicated stage agent receives. */
  readonly instruction: string
  /** Optional dedicated preset (defaults to the resolved default preset). */
  readonly agentPreset?: string
  /** Total trigger budget for this stage; default 1. */
  readonly maxRuns?: number
}

/** One ordered pipeline stage. */
export interface StageRecord {
  readonly id: string
  readonly kind: 'discipline' | 'agent' | 'gate' | 'persist' | 'human' | 'switch' | 'tool' | 'notify'
  readonly title: string
  /** `discipline`: injected verbatim. `notify`: the notice text. */
  readonly text?: string
  /** `agent`: execution payload. */
  readonly run?: StageRun
  /** `agent`/`gate`: trigger configuration. */
  readonly when?: StageWhen
  /** `gate` (P2.2): rubric lines the reviewer scores against. */
  readonly rubric?: readonly string[]
  /** `gate` (P2.2): rework policy; maxRework defaults to 2, 0 means pass-through review only. */
  readonly rework?: { readonly maxRework?: number }
  /** `persist` (P2.3): output contract. */
  readonly template?: string
  readonly persistDirectory?: string
  readonly profileFile?: string
  /** `human` (P2.5): the confirmation question; `detail` is optional context. */
  readonly question?: string
  readonly detail?: string
  /** `switch` (P2.5): route names; each becomes an outlet of the node. */
  readonly routes?: readonly string[]
  /** `tool` (P2.5): shell command executed unattended when the stage fires. */
  readonly command?: string
  /** `notify` (P2.5): optional webhook URL that also receives the notice. */
  readonly webhook?: string
  /** P2.4 DAG: outgoing edge — stage ids fired once this one completes (gate uses `branch`). */
  readonly next?: readonly string[]
  /** P2.4 DAG: conditional routing. Gate uses `pass`/`fail`; switch uses route names as keys. */
  readonly branch?: { readonly [route: string]: readonly string[] }
  /** P2.4 canvas: persisted editor position. */
  readonly position?: { readonly x: number; readonly y: number }
}

/** Stage disciplines kept as legacy flat fields for P1 compatibility. */
export interface ScenarioInstructions {
  readonly clarify: string
  readonly loop: string
  readonly verify: string
}

/** One scenario record. */
export interface ScenarioRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly builtin?: boolean
  /** P2.1 ordered pipeline; absent records synthesize it from the flat fields. */
  readonly stages?: readonly StageRecord[]
  /** Canvas-only: stage ids wired to the entry node (persistent entry edges). */
  readonly roots?: readonly string[]
  /** Canvas-only: stage ids wired to the exit node (persistent exit edges). */
  readonly exits?: readonly string[]
  readonly instructions: ScenarioInstructions
  readonly outputs: { readonly template: string; readonly persistDirectory: string }
  readonly memory?: { readonly profileFile?: string }
  readonly createdAt: number
  readonly updatedAt: number
}

/** Plugin config. */
export interface Config {
  readonly dir?: string
  readonly tasksDir?: string
}

export const name = 'scenarios'
export const inject = ['systemPrompt', 'agents']
export const Config = z.object({
  dir: z.string(),
  tasksDir: z.string(),
})

function scenariosPath(dir: string): string { return join(dir, 'scenarios.json') }
function statePath(dir: string): string { return join(dir, 'state.json') }

// ---- Storage ---------------------------------------------------------------

function toStage(value: unknown): StageRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const KINDS: readonly StageRecord['kind'][] = ['discipline', 'agent', 'gate', 'persist', 'human', 'switch', 'tool', 'notify']
  if (typeof raw.id !== 'string' || raw.id === '') return undefined
  if (typeof raw.title !== 'string' || raw.title === '') return undefined
  if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind as StageRecord['kind'])) return undefined
  const when = raw.when
  const run = raw.run
  const stringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined
  if (when !== undefined && (typeof when !== 'object' || when === null)) return undefined
  if (when !== undefined && (when as Record<string, unknown>).on !== 'turn_end' && (when as Record<string, unknown>).on !== 'idle'
    && (when as Record<string, unknown>).on !== 'explicit' && (when as Record<string, unknown>).on !== 'stage_enter') return undefined
  if (run !== undefined && (typeof run !== 'object' || run === null || typeof (run as Record<string, unknown>).instruction !== 'string')) return undefined
  const stage: {
    id: string
    kind: StageRecord['kind']
    title: string
    text?: string
    run?: StageRun
    when?: StageWhen
    rubric?: string[]
    rework?: { maxRework: number }
    template?: string
    persistDirectory?: string
    profileFile?: string
    question?: string
    detail?: string
    routes?: string[]
    command?: string
    webhook?: string
    next?: string[]
    branch?: { [route: string]: string[] }
    position?: { x: number; y: number }
  } = {
    id: raw.id,
    kind: raw.kind as StageRecord['kind'],
    title: raw.title,
  }
  if (typeof raw.text === 'string') stage.text = raw.text
  if (run !== undefined) {
    stage.run = {
      instruction: (run as Record<string, unknown>).instruction as string,
      ...(typeof (run as Record<string, unknown>).agentPreset === 'string' ? { agentPreset: (run as Record<string, unknown>).agentPreset as string } : {}),
      ...(typeof (run as Record<string, unknown>).maxRuns === 'number' ? { maxRuns: (run as Record<string, unknown>).maxRuns as number } : {}),
    }
  }
  if (when !== undefined) {
    stage.when = {
      on: (when as Record<string, unknown>).on as StageWhen['on'],
      ...(typeof (when as Record<string, unknown>).turnIndex === 'number' ? { turnIndex: (when as Record<string, unknown>).turnIndex as number } : {}),
    }
  }
  if (Array.isArray(raw.rubric) && raw.rubric.every(item => typeof item === 'string')) stage.rubric = raw.rubric as string[]
  if (typeof raw.rework === 'object' && raw.rework !== null && typeof (raw.rework as { maxRework?: unknown }).maxRework === 'number') {
    stage.rework = { maxRework: (raw.rework as { maxRework: number }).maxRework }
  }
  if (typeof raw.template === 'string') stage.template = raw.template
  if (typeof raw.persistDirectory === 'string') stage.persistDirectory = raw.persistDirectory
  if (typeof raw.profileFile === 'string') stage.profileFile = raw.profileFile
  if (typeof raw.question === 'string') stage.question = raw.question
  if (typeof raw.detail === 'string') stage.detail = raw.detail
  if (typeof raw.command === 'string') stage.command = raw.command
  if (typeof raw.webhook === 'string') stage.webhook = raw.webhook
  const routes = stringArray(raw.routes)
  if (routes !== undefined) stage.routes = routes
  const next = stringArray(raw.next)
  if (next !== undefined) stage.next = next
  if (typeof raw.branch === 'object' && raw.branch !== null) {
    const branchRaw = raw.branch as Record<string, unknown>
    const branch: { [route: string]: string[] } = {}
    for (const [route, targets] of Object.entries(branchRaw)) {
      const list = stringArray(targets)
      if (list !== undefined && list.length > 0) branch[route] = list
    }
    if (Object.keys(branch).length > 0) stage.branch = branch
  }
  if (typeof raw.position === 'object' && raw.position !== null
    && typeof (raw.position as Record<string, unknown>).x === 'number' && typeof (raw.position as Record<string, unknown>).y === 'number') {
    stage.position = raw.position as { x: number; y: number }
  }
  return stage
}

function toScenario(value: unknown): ScenarioRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const instructions = raw.instructions
  const outputs = raw.outputs
  if (typeof raw.id !== 'string' || raw.id === '' || typeof raw.name !== 'string' || raw.name === '') return undefined
  if (typeof raw.description !== 'string') return undefined
  if (typeof instructions !== 'object' || instructions === null) return undefined
  const ins = instructions as Record<string, unknown>
  if (typeof ins.clarify !== 'string' || typeof ins.loop !== 'string' || typeof ins.verify !== 'string') return undefined
  if (typeof outputs !== 'object' || outputs === null) return undefined
  const out = outputs as Record<string, unknown>
  if (typeof out.template !== 'string' || typeof out.persistDirectory !== 'string') return undefined
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    ...(raw.builtin === true ? { builtin: true } : {}),
    ...(Array.isArray(raw.stages) ? { stages: raw.stages.map(toStage).filter((s): s is StageRecord => s !== undefined) } : {}),
    ...(Array.isArray(raw.roots) ? { roots: raw.roots.filter((v): v is string => typeof v === 'string') } : {}),
    ...(Array.isArray(raw.exits) ? { exits: raw.exits.filter((v): v is string => typeof v === 'string') } : {}),
    instructions: { clarify: ins.clarify, loop: ins.loop, verify: ins.verify },
    outputs: { template: out.template, persistDirectory: out.persistDirectory },
    ...(typeof (raw.memory as { profileFile?: unknown } | undefined)?.profileFile === 'string'
      ? { memory: { profileFile: (raw.memory as { profileFile: string }).profileFile } }
      : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  }
}

function readScenarios(dir: string): ScenarioRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(scenariosPath(dir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { scenarios?: unknown }).scenarios)) return []
    return ((parsed as { scenarios: unknown[] }).scenarios)
      .map(toScenario)
      .filter((record): record is ScenarioRecord => record !== undefined)
  } catch {
    return []
  }
}

function writeScenarios(dir: string, scenarios: ScenarioRecord[]): void {
  writeFileSync(scenariosPath(dir), `${JSON.stringify({ scenarios }, null, 2)}\n`)
}

/** Per-session trigger bookkeeping for the stage engine. */
interface SessionStageState {
  scenarioId: string
  /** Finished `turn/end` count for the current scenario. */
  turns: number
  /** Fires per stage id. */
  readonly hookRuns: Record<string, number>
  /** Rework count per gate id (P2.2). */
  readonly rework: Record<string, number>
  /** P2.4 DAG: fired-edge bookkeeping, keys are `source>target`. */
  readonly edges: Record<string, true>
}

function readStates(dir: string): Record<string, SessionStageState> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(dir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const states = (parsed as { states?: Record<string, { scenarioId?: unknown; turns?: unknown; hookRuns?: unknown; rework?: unknown; edges?: unknown }> }).states ?? {}
    const normalized: Record<string, SessionStageState> = {}
    for (const [sessionId, raw] of Object.entries(states)) {
      if (typeof raw?.scenarioId !== 'string') continue
      normalized[sessionId] = {
        scenarioId: raw.scenarioId,
        turns: typeof raw.turns === 'number' ? raw.turns : 0,
        hookRuns: typeof raw.hookRuns === 'object' && raw.hookRuns !== null ? raw.hookRuns as Record<string, number> : {},
        rework: typeof raw.rework === 'object' && raw.rework !== null ? raw.rework as Record<string, number> : {},
        edges: typeof raw.edges === 'object' && raw.edges !== null ? raw.edges as Record<string, true> : {},
      }
    }
    return normalized
  } catch {
    return {}
  }
}

function writeStates(dir: string, states: Record<string, SessionStageState>): void {
  writeFileSync(statePath(dir), `${JSON.stringify({ states }, null, 2)}\n`)
}

// ---- Task resolution -------------------------------------------------------

interface TaskLike {
  readonly id: string
  readonly title?: string
  readonly purpose?: string
  readonly sessions: readonly string[]
  readonly category: 'work' | 'learning'
  readonly scenario?: string
  readonly dirName?: string
}

const DEFAULT_TASK_ID = 'task-misc'

function readTasks(tasksDir: string): TaskLike[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(tasksDir, 'tasks.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { tasks?: unknown }).tasks)) return []
    return ((parsed as { tasks: unknown[] }).tasks).filter((task): task is TaskLike =>
      typeof task === 'object' && task !== null && typeof (task as Record<string, unknown>).id === 'string')
  } catch {
    return []
  }
}

function currentTaskFor(tasks: readonly TaskLike[], sessionId: string): TaskLike | undefined {
  return tasks.find(task => task.sessions.includes(sessionId))
    ?? tasks.find(task => task.id === DEFAULT_TASK_ID)
}

function scenarioIdForTask(task: TaskLike): string {
  if (typeof task.scenario === 'string' && task.scenario !== '') return task.scenario
  return task.category === 'learning' ? 'learning' : 'work'
}

// ---- Stage pipeline view ---------------------------------------------------

/** The effective ordered pipeline: explicit `stages`, else the P1 synthesis. */
export function effectiveStages(scenario: ScenarioRecord): readonly StageRecord[] {
  if (scenario.stages !== undefined && scenario.stages.length > 0) return scenario.stages
  return [
    { id: 'clarify', kind: 'discipline', title: '前置澄清', text: scenario.instructions.clarify },
    { id: 'loop', kind: 'discipline', title: '主循环', text: scenario.instructions.loop },
    { id: 'review', kind: 'gate', title: '审核关卡', rubric: [scenario.instructions.verify] },
    {
      id: 'persist', kind: 'persist', title: '落盘 · 回写',
      template: scenario.outputs.template,
      persistDirectory: scenario.outputs.persistDirectory,
      ...(scenario.memory?.profileFile === undefined ? {} : { profileFile: scenario.memory.profileFile }),
    },
  ]
}

/** The `agent` stages the engine can drive. */
function agentStages(scenario: ScenarioRecord): readonly StageRecord[] {
  return effectiveStages(scenario).filter(stage => stage.kind === 'agent' && stage.run !== undefined)
}

// ---- Injection (P1 semantics over the stage pipeline) ----------------------

const VARIABLE_REF = /\{\{([^{}]*)\}\}/g

function defuseVariables(text: string): string {
  return text.replace(VARIABLE_REF, (whole: string, name: string): string =>
    /^[a-z][a-z0-9_]*$/.test(name) ? whole : whole.replaceAll('{', '｛').replaceAll('}', '｝'))
}

function expandPattern(pattern: string, task: TaskLike): string {
  return pattern.replaceAll('{{task.dirName}}', task.dirName ?? task.id)
}

function profileContent(dir: string, scenario: ScenarioRecord): string {
  const file = scenario.memory?.profileFile
  if (file === undefined || file === '') return ''
  try {
    return readFileSync(join(dir, file), 'utf8').trim()
  } catch {
    return ''
  }
}

/** Render the runtime-context block injected for one scenario. */
export function renderScenarioContext(scenario: ScenarioRecord, task: TaskLike, dir: string): string {
  const lines: string[] = [
    `# 场景编排：${scenario.name}`,
    '',
    `当前会话运行在「${scenario.name}」场景编排下（场景 id：${scenario.id}）。管线阶段与纪律如下：`,
  ]
  for (const stage of effectiveStages(scenario)) {
    lines.push('', `## ${stage.title}`)
    if (stage.kind === 'discipline') {
      lines.push(stage.text ?? '')
    } else if (stage.kind === 'agent' && stage.run !== undefined) {
      lines.push(
        `本阶段由独立的「${stage.title}」完成：它会自动启动并把结果以系统通知回注到本会话。`,
        `在收到该结果之前，不要开始后续阶段的工作。`,
        `其职责概述：${stage.run.instruction.split('\n')[0] ?? ''}`,
      )
    } else if (stage.kind === 'gate') {
      lines.push(
        ...(stage.rubric ?? []).length > 0 ? [...(stage.rubric ?? [])] : ['（无 rubric）'],
        '本阶段为审核关卡：完成主要工作后调用 pipeline_review 工具提交审核，审核结果将以系统通知回注；未通过时按审核意见修订后再次提交。',
      )
    } else if (stage.kind === 'persist') {
      lines.push(
        '产出整理成文档时，遵循以下模板结构：',
        stage.template ?? scenario.outputs.template,
        `涉及文件落盘时，写入任务输出目录：${expandPattern(stage.persistDirectory ?? scenario.outputs.persistDirectory, task)}`,
      )
    } else if (stage.kind === 'human') {
      lines.push(
        '本阶段为人工确认点：流程到达时会弹出确认卡片等待用户决定，未经确认不要推进后续阶段。',
        stage.question === undefined || stage.question === '' ? '' : `确认问题：${stage.question}`,
      )
    } else if (stage.kind === 'switch') {
      lines.push(
        `本阶段为路由判定点：会由独立判定器从以下路线中选择一条并自动推进——${(stage.routes ?? []).join(' / ')}。`,
      )
    } else if (stage.kind === 'tool') {
      lines.push(
        '本阶段为工具执行点：到达时会自动执行配置的命令并把输出回注，无需你执行。',
        stage.command === undefined || stage.command === '' ? '' : `命令：${stage.command}`,
      )
    } else if (stage.kind === 'notify') {
      lines.push(
        '本阶段为通知点：到达时会自动发出配置的通知（正文如下），无需你执行。',
        stage.text ?? '',
      )
    }
  }
  const profile = profileContent(dir, scenario)
  if (profile !== '') {
    lines.push('', '## 读者画像', '以下是用户的既有知识画像，输出内容时以此为基准自适应深度：', profile)
  }
  return defuseVariables(lines.join('\n'))
}

// ---- Stage-agent engine (P2.1) ---------------------------------------------

/** Structural view of the services the engine reaches through the scope. */
interface EngineAgents {
  create(options: {
    sessionId?: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider: string; model: string }
    setup?: (agentCtx: unknown) => Promise<void> | void
  }): Promise<{ dispose(): Promise<void>; agent: EngineAgent }>
  get(sessionId: string): EngineAgent | undefined
}

interface EngineAgent {
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd?: string }
    /** Session history read for the harvest below (deprecated seam, same as the subagent driver). */
    snapshotEvents(boundary?: number): unknown[]
  }
  followup(message: unknown): void
  whenIdle(): Promise<void>
}

/** Minimal harvest: the last assistant message's text blocks. */
function harvestAssistantText(events: readonly unknown[]): string {
  let text = ''
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const record = event as { type?: unknown; data?: { message?: { content?: unknown }; content?: unknown } }
    if (record.type !== 'assistant/message') continue
    // The event nests the message: data.message.content (fallback: flat data.content).
    const content = record.data?.message?.content ?? record.data?.content
    if (!Array.isArray(content)) continue
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text)
      }
    }
    if (parts.length > 0) text = parts.join('\n')
  }
  return text
}

/**
 * Run one stage agent to completion and feed its result back into the parent
 * conversation. The child gets the standard preset composition (files,
 * terminal, …) exactly like board-created conversations; its session is
 * disposed after the harvest.
 *
 * Stage agents are unattended: a tool approval nobody answers would hang
 * `whenIdle()` forever (observed with pwsh), so the idle wait races a
 * timeout — a partial harvest still feeds back, with the timeout noted.
 */
const STAGE_IDLE_TIMEOUT_MS = 5 * 60_000

async function runStageAgent(
  agents: EngineAgents,
  presets: { resolve(id?: string): Promise<{ id: string }>; mount(agentCtx: unknown, id?: string): Promise<unknown> } | undefined,
  defaultModel: { currentSelection(): { provider: string; model: string } } | undefined,
  parent: EngineAgent,
  task: TaskLike,
  scenario: ScenarioRecord,
  stage: StageRecord,
): Promise<void> {
  const run = stage.run
  if (run === undefined) return
  const cwd = parent.session.header.cwd
  if (typeof cwd !== 'string' || cwd === '') return
  const preset = presets === undefined ? undefined : await presets.resolve(run.agentPreset)
  const sessionId = `stage-${randomUUID()}`
  const handle = await agents.create({
    sessionId,
    meta: { cwd, ...(preset === undefined ? {} : { agentPreset: preset.id }) },
    ...(defaultModel === undefined ? {} : {
      agentOptions: (() => { const { provider, model } = defaultModel.currentSelection(); return { provider, model } })(),
    }),
    ...(preset === undefined ? {} : {
      setup: async (agentCtx: unknown): Promise<void> => { await presets?.mount(agentCtx, preset.id) },
    }),
  })
  let timedOut = false
  try {
    const child = handle.agent
    child.followup(createUserMessage({
      content: [{
        type: 'text',
        text: [
          `你在场景「${scenario.name}」中承担阶段「${stage.title}」。`,
          `任务：${task.title ?? task.id}`,
          task.purpose === undefined || task.purpose === '' ? '' : `任务目的：${task.purpose}`,
          '',
          `你的职责：`,
          run.instruction,
          '',
          '约束：你是无人值守的一次性阶段 agent——没有人会答复工具审批，因此不要使用需要审批确认的工具（如执行终端命令）；优先用检索与文件读取完成职责。',
          '完成后给出结构化的最终结果报告（Markdown），只完成本阶段职责，不要展开后续阶段的工作。',
        ].filter(line => line !== '').join('\n'),
      }],
      source: { kind: 'user' },
    }))
    await Promise.race([
      child.whenIdle(),
      new Promise<void>(resolve => {
        setTimeout(() => { timedOut = true; resolve() }, STAGE_IDLE_TIMEOUT_MS)
      }),
    ])
    const output = harvestAssistantText(child.session.snapshotEvents())
    parent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: output === ''
          ? `[场景编排 · ${stage.title}] 阶段 agent 已结束，但没有产出文本结果。请基于既有信息继续。`
          : `[场景编排 · ${stage.title} 结果${timedOut ? '（超时收割，可能不完整）' : ''}]\n\n${output}\n\n（请基于以上结果继续「${scenario.name}」的后续阶段。）`,
      }],
      source: { kind: 'scenario-hook', form: 'notice', summary: `${scenario.name}/${stage.title}` },
    }))
  } finally {
    void handle.dispose().catch(() => {})
  }
}

/** Everything the DAG engine needs to fire stage agents for one conversation. */
interface FireCtx {
  readonly agents: EngineAgents
  readonly presets: { resolve(id?: string): Promise<{ id: string }>; mount(agentCtx: unknown, id?: string): Promise<unknown> } | undefined
  readonly defaultModel: { currentSelection(): { provider: string; model: string } } | undefined
  readonly dir: string
  readonly inflight: Set<string>
  readonly parent: EngineAgent
  readonly task: TaskLike
  readonly scenario: ScenarioRecord
  readonly sessionId: string
  readonly state: SessionStageState
  /** Late-bound user-questions channel (human confirm nodes). */
  readonly questions: () => UserQuestionsLike | undefined
}

/** Structural view of the user-questions service (same shape the tasks plugin uses). */
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

/** Install the turn-boundary engine on a scope carrying the needed services. */
function installStageEngine(scope: Context, dir: string, tasksDir: string): void {
  const agents = (scope as unknown as { agents?: EngineAgents }).agents
  const presets = (scope as unknown as {
    agentPresets?: { resolve(id?: string): Promise<{ id: string }>; mount(agentCtx: unknown, id?: string): Promise<unknown> }
  }).agentPresets
  const defaultModel = (scope as unknown as { agentDefaultModel?: { currentSelection(): { provider: string; model: string } } }).agentDefaultModel
  if (agents === undefined) return
  const inflight = new Set<string>()
  scope.on('session/event', (session: { id: string }, event: { type: string }) => {
    if (event.type !== 'turn/end') return
    const sessionId = session.id
    if (inflight.has(sessionId)) return
    const task = currentTaskFor(readTasks(tasksDir), sessionId)
    if (task === undefined) return
    const scenario = readScenarios(dir).find(item => item.id === scenarioIdForTask(task))
    if (scenario === undefined) return
    const stages = agentStages(scenario)
    if (stages.length === 0) return
    const states = readStates(dir)
    const state = states[sessionId] ?? { scenarioId: scenario.id, turns: 0, hookRuns: {}, rework: {}, edges: {} }
    if (state.scenarioId !== scenario.id) {
      state.scenarioId = scenario.id
      state.turns = 0
      for (const key of Object.keys(state.hookRuns)) delete state.hookRuns[key]
      for (const key of Object.keys(state.rework)) delete state.rework[key]
      for (const key of Object.keys(state.edges)) delete state.edges[key]
    }
    state.turns += 1
    const due = stages.filter(stage => {
      const when = stage.when
      if (when !== undefined && when.on !== 'turn_end') return false
      if (when?.turnIndex !== undefined && state.turns < when.turnIndex) return false
      const runs = state.hookRuns[stage.id] ?? 0
      return runs < (stage.run?.maxRuns ?? 1)
    })
    for (const stage of due) state.hookRuns[stage.id] = (state.hookRuns[stage.id] ?? 0) + 1
    states[sessionId] = state
    writeStates(dir, states)
    if (due.length === 0) return
    const parent = agents.get(sessionId)
    if (parent === undefined) return
    const ctx: FireCtx = {
      agents, presets, defaultModel, dir, inflight, parent, task, scenario, sessionId, state,
      questions: () => (scope as unknown as { get?: (name: string) => unknown }).get?.('userQuestions') as UserQuestionsLike | undefined,
    }
    inflight.add(sessionId)
    // Fan-out: source-triggered stages run in parallel, each propagating over
    // its outgoing edges when done.
    void Promise.allSettled(due.map(stage =>
      runStageAgent(agents, presets, defaultModel, parent, task, scenario, stage)
        .then(() => { fireTargets(ctx, stage, 'pass') })
        .catch((error: unknown) => { console.warn('[dsh-scenarios] stage agent failed:', error) }),
    ))
      .finally(() => { inflight.delete(sessionId) })
  })
  installGateTool(scope, dir, tasksDir, agents, presets, defaultModel, inflight)
}

/** DAG edges: stage ids this one fires when it completes (`pass` side for gates). */
function outgoingIds(stage: StageRecord): readonly string[] {
  if (stage.kind === 'gate') {
    return [...(stage.branch?.pass ?? []), ...(stage.next ?? [])]
  }
  return [...(stage.next ?? [])]
}

/** Stages whose outgoing edges point at `targetId` (join inputs, all edge kinds). */
function incomingStages(stages: readonly StageRecord[], targetId: string): readonly StageRecord[] {
  return stages.filter(source =>
    outgoingIds(source).includes(targetId)
    || Object.values(source.branch ?? {}).some(list => list.includes(targetId)))
}

/** Post one scenario-hook notice into the parent conversation. */
function notice(ctx: FireCtx, text: string, summary: string): void {
  ctx.parent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'scenario-hook', form: 'notice', summary },
  }))
}

/**
 * P2.4 DAG propagation: mark the fired edges done, then fire every target whose
 * join inputs are all satisfied. Agent targets run in parallel (respecting
 * maxRuns); the P2.5 control nodes run their own executors; plain targets get
 * an entry notice and pass through. Edge bookkeeping makes re-propagation
 * idempotent, which also guards cycles.
 */
function fireTargets(ctx: FireCtx, stage: StageRecord, route: string): void {
  const stages = effectiveStages(ctx.scenario)
  const ids = route === 'pass'
    ? [...(stage.branch?.pass ?? []), ...(stage.next ?? [])]
    : [...(stage.branch?.[route] ?? [])]
  const states = readStates(ctx.dir)
  const state = states[ctx.sessionId] ?? ctx.state
  const changed: string[] = []
  for (const id of ids) {
    const key = `${stage.id}>${id}`
    if (state.edges[key] !== true) {
      state.edges[key] = true
      changed.push(id)
    }
  }
  if (changed.length > 0) {
    states[ctx.sessionId] = state
    writeStates(ctx.dir, states)
  }
  for (const id of ids) {
    const target = stages.find(item => item.id === id)
    if (target === undefined) continue
    const incoming = incomingStages(stages, id)
    const ready = incoming.every(source => state.edges[`${source.id}>${id}`] === true)
    if (!ready) continue
    if (target.kind === 'agent') {
      const runs = state.hookRuns[id] ?? 0
      if (runs >= (target.run?.maxRuns ?? 1)) continue
      state.hookRuns[id] = runs + 1
      const next: FireCtx = { ...ctx, state }
      void runStageAgent(ctx.agents, ctx.presets, ctx.defaultModel, ctx.parent, ctx.task, ctx.scenario, target)
        .then(() => { fireTargets(next, target, 'pass') })
        .catch((error: unknown) => { console.warn('[dsh-scenarios] stage agent failed:', error) })
    } else if (target.kind === 'human') {
      void runHumanConfirm({ ...ctx, state }, target)
    } else if (target.kind === 'switch') {
      void runRouter({ ...ctx, state }, target)
    } else if (target.kind === 'tool') {
      void runToolStage({ ...ctx, state }, target)
    } else if (target.kind === 'notify') {
      void runNotifyStage({ ...ctx, state }, target)
    } else {
      ctx.parent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `[场景编排] 上游阶段完成，进入阶段「${target.title}」。${target.kind === 'gate' ? '完成主要工作后请调用 pipeline_review 提交审核。' : ''}`,
        }],
        source: { kind: 'scenario-hook', form: 'notice', summary: `${ctx.scenario.name}/${target.title} ENTER` },
      }))
      const next: FireCtx = { ...ctx, state }
      fireTargets(next, target, 'pass')
    }
  }
}

/** The strict verdict line the reviewer must emit. */
const REVIEW_VERDICT = /VERDICT:\s*(PASS|FAIL)/iu

/** The route line a switch judge must emit. */
const ROUTE_LINE = /ROUTE:\s*([^\n]+)/iu

/**
 * Run one throwaway judge session (reviewer / router share this machinery):
 * own session, standard preset + default model, idle-race timeout, harvest.
 */
async function runJudgeSession(ctx: FireCtx, prompt: string): Promise<string> {
  const { agents, presets, defaultModel, parent } = ctx
  const cwd = parent.session.header.cwd
  if (typeof cwd !== 'string' || cwd === '') return ''
  const preset = presets === undefined ? undefined : await presets.resolve(undefined)
  const handle = await agents.create({
    sessionId: `judge-${randomUUID()}`,
    meta: { cwd, ...(preset === undefined ? {} : { agentPreset: preset.id }) },
    ...(defaultModel === undefined ? {} : {
      agentOptions: (() => { const { provider, model } = defaultModel.currentSelection(); return { provider, model } })(),
    }),
    ...(preset === undefined ? {} : {
      setup: async (agentCtx: unknown): Promise<void> => { await presets?.mount(agentCtx, preset.id) },
    }),
  })
  try {
    const child = handle.agent
    child.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await Promise.race([
      child.whenIdle(),
      new Promise<void>(resolve => { setTimeout(resolve, STAGE_IDLE_TIMEOUT_MS) }),
    ])
    return harvestAssistantText(child.session.snapshotEvents())
  } finally {
    void handle.dispose().catch(() => {})
  }
}

/** `human`: pause the flow until the user confirms via the questions card. */
const HUMAN_CONTINUE = '继续'
const HUMAN_STOP = '终止'
const HUMAN_ASK_TIMEOUT_MS = 10 * 60_000

async function runHumanConfirm(ctx: FireCtx, stage: StageRecord): Promise<void> {
  const { parent, scenario } = ctx
  const interaction = ctx.questions()
  if (interaction === undefined) {
    notice(ctx, `[场景编排 · ${stage.title}] 人工确认节点没有可用的交互通道，流程在此暂停；请直接在对话中表明是否继续。`, `${scenario.name}/${stage.title} HUMAN-NOCHANNEL`)
    return
  }
  const questionId = `human-${stage.id}`
  try {
    const answer = await interaction.ask({
      questions: [{
        id: questionId,
        header: `场景确认 · ${stage.title}`,
        question: stage.question === undefined || stage.question === '' ? `阶段「${stage.title}」到达人工确认点，是否继续？` : stage.question,
        ...(stage.detail === undefined || stage.detail === '' ? {} : { detail: stage.detail }),
        options: [
          { label: HUMAN_CONTINUE, description: '确认通过，流程进入下一阶段。' },
          { label: HUMAN_STOP, description: '终止后续阶段；可在输入框写下意见。' },
        ],
      }],
      agent: parent,
      signal: AbortSignal.timeout(HUMAN_ASK_TIMEOUT_MS),
    })
    const item = answer.answers.find(entry => entry.id === questionId)
    const approved = item !== undefined && item.selected.length === 1 && item.selected[0] === HUMAN_CONTINUE && item.custom === undefined
    if (approved) {
      notice(ctx, `[场景编排 · ${stage.title}] 用户已确认，进入后续阶段。`, `${scenario.name}/${stage.title} HUMAN-PASS`)
      fireTargets(ctx, stage, 'pass')
      return
    }
    const feedback = item?.custom ?? ''
    notice(ctx, `[场景编排 · ${stage.title}] 用户终止了后续阶段${feedback === '' ? '' : `，意见：${feedback}`}。请按用户意见调整。`, `${scenario.name}/${stage.title} HUMAN-STOP`)
  } catch (cause: unknown) {
    const code = (cause as { code?: unknown }).code
    const reason = code === 'ASK_CANCELLED'
      ? '用户关闭了确认卡片转而发言'
      : code === 'NO_PROVIDER'
        ? '确认卡片无法送达可见的会话面板'
        : '确认超时或失败'
    notice(ctx, `[场景编排 · ${stage.title}] 人工确认未完成（${reason}），流程在此暂停。`, `${scenario.name}/${stage.title} HUMAN-ERROR`)
    console.warn('[dsh-scenarios] human confirm failed:', cause)
  }
}

/** `switch`: an independent judge picks one of the configured routes. */
async function runRouter(ctx: FireCtx, stage: StageRecord): Promise<void> {
  const { scenario, task, parent } = ctx
  const routes = stage.routes ?? []
  if (routes.length === 0) {
    notice(ctx, `[场景编排 · ${stage.title}] 路由节点未配置任何出口（routes 为空），流程在此暂停。`, `${scenario.name}/${stage.title} SWITCH-NOROUTES`)
    return
  }
  const underReview = harvestAssistantText(parent.session.snapshotEvents())
  const output = await runJudgeSession(ctx, [
    `你是场景「${scenario.name}」的路由判定器，负责节点「${stage.title}」。`,
    `任务：${task.title ?? task.id}`,
    task.purpose === undefined || task.purpose === '' ? '' : `任务目的：${task.purpose}`,
    '',
    '判定说明：',
    stage.run?.instruction ?? '根据任务的当前状态与上下文，选择最合适的路线。',
    '',
    '可选路线（必须原样选择其中一个名称）：',
    ...routes.map(route => `- ${route}`),
    '',
    '待判定上下文（主 agent 的最新产出）：',
    underReview === '' ? '（没有可判定的文本——选择你认为最合理的路线并说明理由）' : underReview,
    '',
    '你是无人值守的判定器：不要使用需要审批确认的工具（如执行终端命令）。',
    '输出格式（严格遵守，第一行必须是路由行）：',
    'ROUTE: <路线名>',
    '随后用一两句话说明选择理由。',
  ].filter(line => line !== '').join('\n'))
  const match = ROUTE_LINE.exec(output)
  const route = match?.[1]?.trim() ?? ''
  if (!routes.includes(route)) {
    notice(ctx, `[场景编排 · ${stage.title}] 路由判定无效（未包含合法路线名），流程在此暂停。判定输出：\n\n${output.slice(0, 800)}`, `${scenario.name}/${stage.title} SWITCH-INVALID`)
    return
  }
  notice(ctx, `[场景编排 · ${stage.title}] 路由判定：${route}。\n\n${output.replace(ROUTE_LINE, '').trim()}`, `${scenario.name}/${stage.title} ROUTE:${route}`)
  fireTargets(ctx, stage, route)
}

/** `tool`: run the configured shell command unattended and feed back the output. */
async function runToolStage(ctx: FireCtx, stage: StageRecord): Promise<void> {
  const { parent, scenario } = ctx
  const command = stage.command ?? ''
  if (command.trim() === '') {
    notice(ctx, `[场景编排 · ${stage.title}] 工具节点未配置命令，流程在此暂停。`, `${scenario.name}/${stage.title} TOOL-NOCOMMAND`)
    return
  }
  const cwd = typeof parent.session.header.cwd === 'string' && parent.session.header.cwd !== '' ? parent.session.header.cwd : undefined
  notice(ctx, `[场景编排 · ${stage.title}] 开始执行命令：\n\n${command}`, `${scenario.name}/${stage.title} TOOL-START`)
  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      exec(command, { cwd, timeout: 120_000, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error !== null && (stdout ?? '') === '' && (stderr ?? '') === '') reject(error)
        else resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    })
    const body = [stdout.trim(), stderr.trim() === '' ? '' : `[stderr]\n${stderr.trim()}`].filter(part => part !== '').join('\n')
    notice(ctx, `[场景编排 · ${stage.title}] 命令完成。\n\n${body === '' ? '（无输出）' : body.slice(0, 4000)}`, `${scenario.name}/${stage.title} TOOL-DONE`)
    fireTargets(ctx, stage, 'pass')
  } catch (error: unknown) {
    notice(ctx, `[场景编排 · ${stage.title}] 命令执行失败：${String(error)}。流程在此暂停；请修正后重新触发上游阶段。`, `${scenario.name}/${stage.title} TOOL-ERROR`)
  }
}

/** `notify`: post the configured notice (and webhook) into the flow. */
async function runNotifyStage(ctx: FireCtx, stage: StageRecord): Promise<void> {
  const { scenario, task } = ctx
  const text = stage.text ?? ''
  notice(ctx, `[场景编排 · ${stage.title}] ${text === '' ? '（通知节点未配置正文）' : text}`, `${scenario.name}/${stage.title} NOTIFY`)
  const webhook = stage.webhook
  if (webhook !== undefined && webhook.startsWith('http')) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: scenario.name, task: task.title ?? task.id, stage: stage.title, text, at: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error: unknown) {
      console.warn('[dsh-scenarios] notify webhook failed:', error)
    }
  }
  fireTargets(ctx, stage, 'pass')
}

/**
 * Run one reviewer agent against the parent conversation's latest output and
 * feed the verdict back: pass → release, fail → rework (bounded by the gate's
 * maxRework; exhaustion releases with a note). Reuses the stage-agent
 * machinery (own session, standard preset, idle-race timeout, harvest).
 */
async function runReviewer(ctx: FireCtx, gate: StageRecord): Promise<void> {
  const { parent, task, scenario, state, dir } = ctx
  const rubric = (gate.rubric ?? []).length > 0 ? gate.rubric! : ['回答正确且完成了用户的诉求。']
  const underReview = harvestAssistantText(parent.session.snapshotEvents())
  const output = await runJudgeSession(ctx, [
    `你是场景「${scenario.name}」的独立审核员，负责关卡「${gate.title}」。`,
    `任务：${task.title ?? task.id}`,
    task.purpose === undefined || task.purpose === '' ? '' : `任务目的：${task.purpose}`,
    '',
    '审核 rubric（逐条对照）：',
    ...rubric.map(line => `- ${line}`),
    '',
    '待审产出（主 agent 的最终回答）：',
    underReview === '' ? '（主 agent 没有可审的文本产出——直接判 FAIL 并说明）' : underReview,
    '',
    `你可以在任务输出目录 tasks/${task.dirName ?? task.id}/ 下读取产物文件进行验证（你是无人值守的审核员：不要使用需要审批确认的工具如终端命令）。`,
    '',
    '输出格式（严格遵守，第一行必须是判定行）：',
    'VERDICT: PASS',
    '或',
    'VERDICT: FAIL',
    '随后逐条给出对照 rubric 的简短理由；若 FAIL，给出具体、可执行的修改要求。',
  ].filter(line => line !== '').join('\n'))
  const match = REVIEW_VERDICT.exec(output)
  const verdict: 'pass' | 'fail' | 'unclear' = match === null ? 'unclear' : (match[1]?.toLowerCase() === 'pass' ? 'pass' : 'fail')
  const opinion = output.replace(REVIEW_VERDICT, '').trim()
  const maxRework = gate.rework?.maxRework ?? 2
  if (verdict === 'pass') {
    parent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: `[场景编排 · ${gate.title}] 审核通过。\n\n${opinion}\n\n（产出已过审，可以进入收尾/落盘。）`,
      }],
      source: { kind: 'scenario-hook', form: 'notice', summary: `${scenario.name}/${gate.title} PASS` },
    }))
    // P2.4: pass edges route onward (e.g. gate → persist).
    fireTargets(ctx, gate, 'pass')
    return
  }
  const count = (state.rework[gate.id] ?? 0) + 1
  state.rework[gate.id] = count
  writeStates(dir, { ...readStates(dir), [parent.session.id]: state })
  if (count > maxRework) {
    parent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: `[场景编排 · ${gate.title}] 审核未过，但已达打回上限（${String(maxRework)} 次），按配置放行。审核意见（供参考）：\n\n${opinion}`,
      }],
      source: { kind: 'scenario-hook', form: 'notice', summary: `${scenario.name}/${gate.title} EXHAUSTED` },
    }))
    // Released at the cap — treat as passed for routing purposes.
    fireTargets(ctx, gate, 'pass')
    return
  }
  // P2.4: an explicit fail edge routes elsewhere (e.g. a repair agent);
  // without one the default is in-place rework.
  if ((gate.branch?.fail ?? []).length > 0) {
    parent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: `[场景编排 · ${gate.title}] 审核未过（第 ${String(count)}/${String(maxRework)} 次），按编排转入后续处理。审核意见：\n\n${opinion}`,
      }],
      source: { kind: 'scenario-hook', form: 'notice', summary: `${scenario.name}/${gate.title} FAIL-ROUTE` },
    }))
    fireTargets(ctx, gate, 'fail')
    return
  }
  parent.followup(createUserMessage({
    content: [{
      type: 'text',
      text: verdict === 'unclear'
        ? `[场景编排 · ${gate.title}] 审核员未能给出明确判定（第 ${String(count)}/${String(maxRework)} 次）。请自查后再次调用 pipeline_review 提交审核。`
        : `[场景编排 · ${gate.title}] 审核未过（第 ${String(count)}/${String(maxRework)} 次）。审核意见：\n\n${opinion}\n\n请按意见修订，然后再次调用 pipeline_review 提交审核。`,
    }],
    source: { kind: 'scenario-hook', form: 'notice', summary: `${scenario.name}/${gate.title} REWORK` },
  }))
}

/** The explicit gate trigger: a model-facing tool that fires the reviewer. */
function installGateTool(
  scope: Context,
  dir: string,
  tasksDir: string,
  agents: EngineAgents,
  presets: { resolve(id?: string): Promise<{ id: string }>; mount(agentCtx: unknown, id?: string): Promise<unknown> } | undefined,
  defaultModel: { currentSelection(): { provider: string; model: string } } | undefined,
  inflight: Set<string>,
): void {
  scope.tools.register(defineTool({
    name: 'pipeline_review',
    description: 'Submit the current work to the scenario review gate (审核关卡). Call it when the scenario instructs the main work is complete — an independent reviewer agent scores the output against the scenario rubric and the verdict arrives as a system notice: PASS releases the work, FAIL returns concrete revision requirements (bounded rework). While a review is in flight, do not call it again.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { submitted: { type: 'boolean', required: true }, note: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Review submitted:\n\n${value.note ?? ''}` }],
    },
    async execute(_args, exec) {
      const session = exec.agent?.session
      if (session === undefined) return { submitted: false, note: 'no session context' }
      const sessionId = session.id
      const task = currentTaskFor(readTasks(tasksDir), sessionId)
      if (task === undefined) return { submitted: false, note: 'no task context' }
      const scenario = readScenarios(dir).find(item => item.id === scenarioIdForTask(task))
      if (scenario === undefined) return { submitted: false, note: 'no scenario for this task' }
      const gate = effectiveStages(scenario).find(stage => stage.kind === 'gate')
      if (gate === undefined) return { submitted: false, note: 'this scenario has no review gate' }
      const parent = agents.get(sessionId)
      if (parent === undefined) return { submitted: false, note: 'conversation is not live' }
      if (inflight.has(sessionId)) return { submitted: false, note: 'a stage agent is still running for this conversation' }
      const states = readStates(dir)
      const state = states[sessionId] ?? { scenarioId: scenario.id, turns: 0, hookRuns: {}, rework: {}, edges: {} }
      if (state.scenarioId !== scenario.id) {
        state.scenarioId = scenario.id
        state.turns = 0
        for (const key of Object.keys(state.hookRuns)) delete state.hookRuns[key]
        for (const key of Object.keys(state.rework)) delete state.rework[key]
        for (const key of Object.keys(state.edges)) delete state.edges[key]
      }
      states[sessionId] = state
      writeStates(dir, states)
      inflight.add(sessionId)
      const ctx: FireCtx = {
        agents, presets, defaultModel, dir, inflight, parent, task, scenario, sessionId, state,
        questions: () => (scope as unknown as { get?: (name: string) => unknown }).get?.('userQuestions') as UserQuestionsLike | undefined,
      }
      void (async () => {
        try {
          await runReviewer(ctx, gate)
        } catch (error: unknown) {
          console.warn('[dsh-scenarios] reviewer failed:', error)
        } finally {
          inflight.delete(sessionId)
        }
      })()
      return { submitted: true, note: `审核员已启动（关卡「${gate.title}」），结果将以系统通知回注。` }
    },
  }))
}

// ---- Seeds -----------------------------------------------------------------

function learningScenario(now: number): ScenarioRecord {
  return {
    id: 'learning',
    name: '深度学习研究',
    description: '从基础命题出发的系统性学习：先澄清，再由调研 agent 全面检索，最后梳理成读者自适应的笔记并沉淀知识画像。',
    builtin: true,
    roots: ['clarify'],
    exits: ['persist'],
    stages: [
      { id: 'clarify', kind: 'discipline', title: '前置澄清', next: ['scout'], position: { x: 40, y: 170 }, text: [
        '拿到学习命题后先判断是否存在关键性信息缺口（目标深度、读者基础、范围边界）。',
        '若有缺口，一次性集中提出澄清问题，等待用户回答后再继续；不要边检索边零散提问。',
      ].join('\n') },
      {
        id: 'scout', kind: 'agent', title: '调研 agent', next: ['loop'], position: { x: 300, y: 170 },
        when: { on: 'turn_end', turnIndex: 1 },
        run: {
          instruction: [
            '围绕学习命题做全面调研，覆盖三个维度：方法原理、数据/实验、争议与局限。',
            '重要结论给出处；输出一份结构化调研纪要（Markdown），作为后续梳理的素材。',
          ].join('\n'),
          maxRuns: 1,
        },
      },
      { id: 'loop', kind: 'discipline', title: '主循环', next: ['review'], position: { x: 560, y: 170 }, text: [
        '1. 基于调研结果梳理要直白：用读者能直接理解的语言重述，必要术语先用一句话解释；按用户既有知识水平自适应深浅。',
        '2. 每轮自评：输出前检查覆盖度——还有哪个维度没讲、哪里可能超纲或太浅，主动补齐或在结尾说明。',
      ].join('\n') },
      { id: 'review', kind: 'gate', title: '审核关卡', when: { on: 'explicit' }, rework: { maxRework: 2 }, branch: { pass: ['persist'] }, position: { x: 820, y: 170 }, rubric: [
        '结束前自检：回答是否忠于检索到的事实（不编造）、是否覆盖三个维度、是否匹配读者水平。',
        '发现缺口先补齐再交卷。',
      ] },
      { id: 'persist', kind: 'persist', title: '落盘 · 回写', position: { x: 1080, y: 170 }, template: [
        '# 〈标题〉',
        '## 要解决的问题',
        '## 知识脉络（由浅入深）',
        '## 关键要点与直觉',
        '## 争议与局限',
        '## 来源',
      ].join('\n'), persistDirectory: 'tasks/{{task.dirName}}/', profileFile: 'knowledge-profile.md' },
    ],
    instructions: { clarify: '', loop: '', verify: '' },
    outputs: { template: '', persistDirectory: 'tasks/{{task.dirName}}/' },
    memory: { profileFile: 'knowledge-profile.md' },
    createdAt: now,
    updatedAt: now,
  }
}

function workScenario(now: number): ScenarioRecord {
  return {
    id: 'work',
    name: '工作交付',
    description: '目标明确的工作执行：开工前集中澄清，一次性做完并验证正确，产物落盘到任务目录。',
    builtin: true,
    roots: ['clarify'],
    exits: ['persist'],
    stages: [
      { id: 'clarify', kind: 'discipline', title: '前置澄清', next: ['loop'], position: { x: 40, y: 160 }, text: [
        '拿到任务先快速分析；若需求存在不清晰或可能影响交付的地方，在开工前第一时间集中提问确认。',
        '确认之后避免中途打断用户。',
      ].join('\n') },
      { id: 'loop', kind: 'discipline', title: '主循环', next: ['review'], position: { x: 300, y: 160 }, text: [
        '1. 优先解决实际问题：围绕交付目标推进，不做无关扩展。',
        '2. 确保正确：关键结论/改动要验证（运行、复查、对照需求），不确定就说明并给出验证方式。',
        '3. 确保完成：以「问题被解决」为完成标准，而不是「做了点什么」。',
      ].join('\n') },
      { id: 'review', kind: 'gate', title: '审核关卡', when: { on: 'explicit' }, rework: { maxRework: 2 }, branch: { pass: ['persist'] }, position: { x: 560, y: 160 }, rubric: [
        '交付前自检：结果是否正确（已验证）、是否真正解决了用户的问题、是否有遗漏的边界情况。',
        '未通过则修复后再交付。',
      ] },
      { id: 'persist', kind: 'persist', title: '落盘 · 回写', position: { x: 820, y: 160 }, template: [
        '# 〈标题〉',
        '## 目标',
        '## 方案与过程',
        '## 结果与验证',
        '## 后续事项',
      ].join('\n'), persistDirectory: 'tasks/{{task.dirName}}/' },
    ],
    instructions: { clarify: '', loop: '', verify: '' },
    outputs: { template: '', persistDirectory: 'tasks/{{task.dirName}}/' },
    createdAt: now,
    updatedAt: now,
  }
}

// ---- Web route -------------------------------------------------------------

interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  tapIndex(transform: (html: string) => string): () => void
}

function serveScenariosApi(scope: Context, dir: string): void {
  try {
    const webServer = (scope as unknown as { webServer?: WebServerLike }).webServer
    if (webServer === undefined) {
      console.error('[dsh-scenarios] webServer service unavailable in scope; route not served')
      return
    }
    const token = randomUUID()
    const disposeTap = webServer.tapIndex(html =>
      html.replace('</head>', `<meta name="dsh-scenarios" content="${token}"></head>`))
    const json = (res: ServerResponse, status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const disposeRoute = webServer.register({
      kind: 'exact',
      path: '/scenarios',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.searchParams.get('token') !== token) {
          json(res, 401, { ok: false })
          return
        }
        if (req.method === 'GET') {
          json(res, 200, { scenarios: readScenarios(dir) })
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
        try {
          if (payload.op === 'save') {
            const record = toScenario(payload.scenario)
            if (record === undefined) {
              json(res, 400, { ok: false, error: 'invalid scenario record' })
              return
            }
            const scenarios = readScenarios(dir)
            const existing = scenarios.findIndex(item => item.id === record.id)
            const next: ScenarioRecord = {
              ...record,
              createdAt: existing >= 0 ? scenarios[existing]?.createdAt ?? Date.now() : Date.now(),
              updatedAt: Date.now(),
            }
            if (existing >= 0) scenarios.splice(existing, 1, next)
            else scenarios.push(next)
            writeScenarios(dir, scenarios)
            json(res, 200, { ok: true, scenario: next })
            return
          }
          if (payload.op === 'delete' && typeof payload.id === 'string') {
            const scenarios = readScenarios(dir)
            const existing = scenarios.find(item => item.id === payload.id)
            if (existing === undefined) {
              json(res, 404, { ok: false, error: 'unknown scenario' })
              return
            }
            if (existing.builtin === true) {
              json(res, 400, { ok: false, error: 'built-in scenarios cannot be deleted' })
              return
            }
            writeScenarios(dir, scenarios.filter(item => item.id !== payload.id))
            json(res, 200, { ok: true })
            return
          }
        } catch (error: unknown) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'scenario op failed' })
          return
        }
        json(res, 400, { ok: false })
      },
    })
    scope.effect(() => () => {
      disposeRoute()
      disposeTap()
    }, 'scenarios: web route')
  } catch (error: unknown) {
    console.error('[dsh-scenarios] route setup failed:', error)
  }
}

// ---- Plugin entry ----------------------------------------------------------

export function apply(ctx: Context, config: Config): void {
  const dir = config.dir ?? dshHomePath('scenarios')
  const tasksDir = config.tasksDir ?? dshHomePath('tasks')
  mkdirSync(dir, { recursive: true })

  // Seed the built-ins on first run; user edits win afterwards.
  {
    const scenarios = readScenarios(dir)
    const now = Date.now()
    let changed = false
    for (const seed of [learningScenario(now), workScenario(now)]) {
      if (!scenarios.some(item => item.id === seed.id)) {
        scenarios.push(seed)
        changed = true
      }
    }
    if (changed) writeScenarios(dir, scenarios)
  }

  ctx.inject(['webServer'], (scope: Context) => { serveScenariosApi(scope, dir) })

  // The stage engine runs behind the services it drives (agents, preset
  // registry, default model, the tool registry for the review gate) and
  // listens for every session's turn boundary.
  ctx.inject(['agents', 'agentPresets', 'agentDefaultModel', 'tools'], (scope: Context) => {
    installStageEngine(scope, dir, tasksDir)
  })

  ctx.systemPrompt.context({
    name: 'scenarios:discipline',
    order: 127,
    text: (context) => {
      const session = context.agent?.session
      if (session === undefined) return ''
      const task = currentTaskFor(readTasks(tasksDir), session.id)
      if (task === undefined) return ''
      const scenario = readScenarios(dir).find(item => item.id === scenarioIdForTask(task))
      if (scenario === undefined) return ''
      return renderScenarioContext(scenario, task, dir)
    },
  })
}
