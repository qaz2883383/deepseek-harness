/** Scenario-orchestration management panel: DAG canvas editor (graph-as-editor), list, and overlay editor. */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useEdgesState,
  useInternalNode,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { BoardKey } from './locales.ts'
import css from './BoardAction.module.css'

/** One ordered pipeline stage, mirrored from the host scenarios plugin. */
export interface StageRecord {
  readonly id: string
  readonly kind: 'discipline' | 'agent' | 'gate' | 'persist' | 'human' | 'switch' | 'tool' | 'notify'
  readonly title: string
  readonly text?: string
  readonly run?: {
    readonly instruction: string
    readonly agentPreset?: string
    readonly maxRuns?: number
  }
  readonly when?: {
    readonly on: 'turn_end' | 'idle' | 'explicit' | 'stage_enter'
    readonly turnIndex?: number
  }
  readonly rubric?: readonly string[]
  readonly rework?: { readonly maxRework?: number }
  readonly template?: string
  readonly persistDirectory?: string
  readonly profileFile?: string
  readonly question?: string
  readonly detail?: string
  readonly routes?: readonly string[]
  readonly command?: string
  readonly webhook?: string
  /** P2.4 DAG: outgoing edge — stage ids fired once this one completes (gate uses `branch`). */
  readonly next?: readonly string[]
  /** P2.4 DAG: conditional routing. Gate uses `pass`/`fail`; switch uses route names as keys. */
  readonly branch?: { readonly [route: string]: readonly string[] }
  /** P2.4 canvas: persisted editor position. */
  readonly position?: { readonly x: number; readonly y: number }
}

/** One scenario record, mirrored from the host scenarios plugin. */
export interface ScenarioRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly builtin?: boolean
  readonly stages?: readonly StageRecord[]
  readonly instructions: { readonly clarify: string; readonly loop: string; readonly verify: string }
  readonly outputs: { readonly template: string; readonly persistDirectory: string }
  readonly memory?: { readonly profileFile?: string }
  readonly createdAt: number
  readonly updatedAt: number
}

/** Translation callback bound to the board namespace. */
export type ScenariosT = (key: BoardKey) => string

/** The effective pipeline: explicit `stages`, else the P1 synthesis. */
function effectiveStages(scenario: ScenarioRecord): readonly StageRecord[] {
  if (scenario.stages !== undefined && scenario.stages.length > 0) return [...scenario.stages]
  return [
    { id: 'clarify', kind: 'discipline', title: '前置澄清', text: scenario.instructions.clarify },
    { id: 'loop', kind: 'discipline', title: '主循环', text: scenario.instructions.loop },
    { id: 'review', kind: 'gate', title: '审核关卡', rubric: [scenario.instructions.verify] },
    {
      id: 'persist', kind: 'persist', title: '落盘 · 回写',
      template: scenario.outputs.template, persistDirectory: scenario.outputs.persistDirectory,
      ...(scenario.memory?.profileFile === undefined ? {} : { profileFile: scenario.memory.profileFile }),
    },
  ]
}

/** Trigger summary shown on the stage node. */
function whenLabel(stage: StageRecord): string {
  if (stage.when === undefined) return stage.kind === 'agent' ? '自动' : ''
  if (stage.when.on === 'turn_end') {
    return stage.when.turnIndex === undefined ? '每轮结束后' : `第 ${stage.when.turnIndex} 轮结束后`
  }
  if (stage.when.on === 'idle') return '会话空闲时'
  if (stage.when.on === 'explicit') return '显式触发'
  return '进入该阶段时'
}

function routeToken(name: string): string | undefined {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? undefined
}

async function fetchScenarios(): Promise<readonly ScenarioRecord[] | undefined> {
  const token = routeToken('dsh-scenarios')
  if (token === undefined) return undefined
  const response = await fetch(`/scenarios?token=${encodeURIComponent(token)}`)
  if (!response.ok) return undefined
  const state = await response.json() as { scenarios?: ScenarioRecord[] }
  return state.scenarios
}

export { fetchScenarios }

async function postScenarios(body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const token = routeToken('dsh-scenarios')
  if (token === undefined) return undefined
  const response = await fetch(`/scenarios?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json() as Record<string, unknown>
}

/** Kind badge label. */
const KIND_LABEL: Record<StageRecord['kind'], string> = {
  discipline: '纪律',
  agent: 'agent',
  gate: '关卡',
  persist: '落盘',
  human: '人工',
  switch: '路由',
  tool: '工具',
  notify: '通知',
}

/** The scenario management panel: toolbar, list, pipeline detail, and editing. */
export function BoardScenariosPanel({ t }: { t: ScenariosT }): React.JSX.Element {
  const [scenarios, setScenarios] = useState<readonly ScenarioRecord[]>([])
  const [ready, setReady] = useState(false)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState<ScenarioRecord | 'new' | null>(null)

  const refresh = async (): Promise<void> => {
    const next = await fetchScenarios()
    if (next !== undefined) setScenarios(next)
    setReady(true)
  }

  useEffect(() => { void refresh() }, [])

  const selected = scenarios.find(item => item.id === selectedId)

  if (editing !== null) {
    return <ScenarioEditor
      scenario={editing === 'new' ? undefined : editing}
      onClose={() => { setEditing(null) }}
      onSaved={() => { setEditing(null); void refresh() }}
      t={t}
    />
  }

  return (
    <div className={css.scenariosBody}>
      <div className={css.scenarioToolbar}>
        <span className={css.scenarioCount}>{t('sc.detail.injected')}</span>
        <button type="button" className={css.scenarioNew} onClick={() => { setEditing('new') }}>
          {t('sc.new')}
        </button>
      </div>
      {!ready
        ? <p className={css.scEmpty}>…</p>
        : scenarios.length === 0
          ? <p className={css.scEmpty}>{t('sc.empty')}</p>
          : <div className={css.scenarioList}>
            {scenarios.map(scenario => (
              <button
                key={scenario.id}
                type="button"
                className={scenario.id === selectedId
                  ? `${css.scenarioCard} ${css.scenarioCardActive}`
                  : css.scenarioCard}
                onClick={() => { setSelectedId(scenario.id) }}
              >
                <span className={css.scenarioCardName}>{scenario.name}</span>
                <span className={css.scenarioCardId}>{scenario.id}{scenario.builtin === true ? ` · ${t('sc.builtin')}` : ''}</span>
              </button>
            ))}
          </div>}
      {selected === undefined ? null : (
        <ScenarioPipeline key={selected.updatedAt} scenario={selected} onChanged={() => { void refresh() }} onEdit={() => { setEditing(selected) }} t={t} />
      )}
    </div>
  )
}

/** The graph-as-editor pipeline: vertical stage flow with per-node editing.
 * Edits stay in a local draft until the user presses save. */
function ScenarioPipeline({ scenario, onChanged, onEdit, t }: {
  scenario: ScenarioRecord
  onChanged: () => void
  onEdit: () => void
  t: ScenariosT
}): React.JSX.Element {
  const [stages, setStages] = useState<readonly StageRecord[]>(() => effectiveStages(scenario))
  const [baseline] = useState<readonly StageRecord[]>(() => effectiveStages(scenario))
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [layoutEpoch, setLayoutEpoch] = useState(0)
  const dirty = JSON.stringify(stages) !== JSON.stringify(baseline)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await postScenarios({
        op: 'save',
        scenario: { ...scenario, stages },
      })
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  const apply = (mutate: (draft: StageRecord[]) => void): void => {
    const next = [...stages]
    mutate(next)
    setStages(next)
  }

  const patchStage = (id: string, patch: Partial<StageRecord>): void => {
    apply(next => {
      const index = next.findIndex(stage => stage.id === id)
      if (index >= 0) next.splice(index, 1, { ...next[index]!, ...patch })
    })
  }

  const open = stages.find(stage => stage.id === openId)

  return (
    <div className={css.scenarioDetail}>
      <div className={css.scenarioDetailHead}>
        <h3 className={css.scenarioDetailName}>{scenario.name}</h3>
        <div className={css.scenarioDetailActions}>
          {dirty ? (
            <>
              <button type="button" className={css.prefsPrimary} disabled={saving} onClick={() => { void save() }}>
                {t('sc.apply')}
              </button>
              <button
                type="button"
                className={css.scenarioAction}
                onClick={() => { setStages(effectiveStages(scenario)); setOpenId(undefined) }}
              >
                {t('sc.discard')}
              </button>
            </>
          ) : null}
          <button type="button" className={css.scenarioAction} onClick={onEdit}>
            {t('sc.edit')}
          </button>
          {scenario.builtin === true ? null : (
            <button
              type="button"
              className={css.scenarioActionDanger}
              onClick={() => {
                if (!window.confirm(t('sc.confirmDelete'))) return
                void (async () => {
                  await postScenarios({ op: 'delete', id: scenario.id })
                  onChanged()
                })()
              }}
            >
              {t('sc.delete')}
            </button>
          )}
        </div>
      </div>
      <p className={css.scenarioDesc}>{scenario.description}</p>
      <p className={css.scHint}>{t('sc.diagramHint')}</p>
      {saving ? <p className={css.scHint}>{t('sc.saving')}</p> : dirty ? <p className={css.scHint}>{t('sc.unsaved')}</p> : null}
      <div className={css.scCanvasToolbar}>
        {ADDABLE_KINDS.map(kind => (
          <button
            key={kind}
            type="button"
            className={css.scCanvasAdd}
            onClick={() => {
              const id = `stage-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`
              apply(next => {
                next.push({
                  id,
                  kind,
                  title: `新${KIND_LABEL[kind]}`,
                  position: { x: 60 + (next.length % 5) * 40, y: 60 + next.length * 90 },
                  ...(kind === 'switch' ? { routes: ['路线A', '路线B'] } : {}),
                })
              })
            }}
          >
            ＋ {t(KIND_ADD_KEY[kind])}
          </button>
        ))}
        <button
          type="button"
          className={css.scCanvasAdd}
          onClick={() => {
            setStages(layoutStages(stages))
            setLayoutEpoch(epoch => epoch + 1)
          }}
        >
          ⟳ {t('sc.canvas.layout')}
        </button>
      </div>
      <ScenarioCanvas
        stages={stages}
        openId={openId}
        layoutEpoch={layoutEpoch}
        onOpen={(id) => { setOpenId(id === openId ? undefined : id) }}
        onStagesChange={setStages}
        t={t}
      />
      {open === undefined ? null : (
        <StageEditor
          stage={open}
          onPatch={(patch) => { patchStage(open.id, patch) }}
          onDelete={() => {
            setStages(stages.filter(stage => stage.id !== open.id))
            setOpenId(undefined)
          }}
          t={t}
        />
      )}
    </div>
  )
}

/** Inline editor for one stage's properties (the graph-as-editor detail panel). */
function StageEditor({ stage, onPatch, onDelete, t }: {
  stage: StageRecord
  onPatch: (patch: Partial<StageRecord>) => void
  onDelete: () => void
  t: ScenariosT
}): React.JSX.Element {
  return (
    <div className={css.scStagePanel}>
      <div className={css.scStagePanelText}>
        <label className={css.prefsField}>
          <span className={css.prefsFieldLabel}>{t('sc.field.kind')}</span>
          <select
            className={css.taskTitleInput}
            value={stage.kind}
            onChange={(event) => { onPatch({ kind: event.target.value as StageRecord['kind'] }) }}
          >
            <option value="discipline">{t('sc.kind.discipline')}</option>
            <option value="agent">{t('sc.kind.agent')}</option>
            <option value="gate">{t('sc.kind.gate')}</option>
            <option value="human">{t('sc.kind.human')}</option>
            <option value="switch">{t('sc.kind.switch')}</option>
            <option value="tool">{t('sc.kind.tool')}</option>
            <option value="notify">{t('sc.kind.notify')}</option>
            <option value="persist">{t('sc.kind.persist')}</option>
          </select>
        </label>
        <label className={css.prefsField}>
          <span className={css.prefsFieldLabel}>{t('sc.field.name')}</span>
          <input
            className={css.taskTitleInput}
            value={stage.title}
            onChange={(event) => { onPatch({ title: event.target.value }) }}
          />
        </label>
        {stage.kind === 'agent' ? (
          <>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.trigger')}</span>
              <select
                className={css.taskTitleInput}
                value={stage.when?.on ?? 'turn_end'}
                onChange={(event) => {
                  const on = event.target.value as NonNullable<StageRecord['when']>['on']
                  onPatch({ when: on === 'turn_end' ? { on, turnIndex: stage.when?.turnIndex ?? 1 } : { on } })
                }}
              >
                <option value="turn_end">{t('sc.when.turn_end')}</option>
                <option value="idle">{t('sc.when.idle')}</option>
                <option value="explicit">{t('sc.when.explicit')}</option>
                <option value="stage_enter">{t('sc.when.stage_enter')}</option>
              </select>
            </label>
            {(stage.when?.on ?? 'turn_end') === 'turn_end' ? (
              <label className={css.prefsField}>
                <span className={css.prefsFieldLabel}>{t('sc.field.turnIndex')}</span>
                <input
                  className={css.taskTitleInput}
                  type="number" min={1}
                  value={stage.when?.turnIndex ?? 1}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    onPatch({ when: { on: 'turn_end', turnIndex: Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1 } })
                  }}
                />
              </label>
            ) : null}
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.maxRuns')}</span>
              <input
                className={css.taskTitleInput}
                type="number" min={1}
                value={stage.run?.maxRuns ?? 1}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  onPatch({ run: { instruction: stage.run?.instruction ?? '', maxRuns: Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1 } })
                }}
              />
            </label>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.instruction')}</span>
              <textarea
                className={css.prefsTextarea} rows={4} spellCheck={false}
                value={stage.run?.instruction ?? ''}
                onChange={(event) => { onPatch({ run: { instruction: event.target.value, ...(stage.run?.agentPreset === undefined ? {} : { agentPreset: stage.run.agentPreset }), ...(stage.run?.maxRuns === undefined ? {} : { maxRuns: stage.run.maxRuns }) } }) }}
              />
            </label>
          </>
        ) : stage.kind === 'discipline' ? (
          <label className={css.prefsField}>
            <span className={css.prefsFieldLabel}>{t('sc.field.discipline')}</span>
            <textarea
              className={css.prefsTextarea} rows={4} spellCheck={false}
              value={stage.text ?? ''}
              onChange={(event) => { onPatch({ text: event.target.value }) }}
            />
          </label>
        ) : stage.kind === 'gate' ? (
          <>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.rubric')}</span>
              <textarea
                className={css.prefsTextarea} rows={3} spellCheck={false}
                value={stage.rubric?.join('\n') ?? ''}
                onChange={(event) => { onPatch({ rubric: event.target.value.split('\n') }) }}
              />
            </label>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.maxRework')}</span>
              <input
                className={css.taskTitleInput}
                type="number" min={0}
                value={stage.rework?.maxRework ?? 2}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  onPatch({ rework: { maxRuns: undefined, maxRework: Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2 } as { maxRework?: number } })
                }}
              />
            </label>
          </>
        ) : stage.kind === 'human' ? (
          <>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.question')}</span>
              <input
                className={css.taskTitleInput}
                value={stage.question ?? ''}
                onChange={(event) => { onPatch({ question: event.target.value }) }}
              />
            </label>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.detail')}</span>
              <textarea
                className={css.prefsTextarea} rows={3} spellCheck={false}
                value={stage.detail ?? ''}
                onChange={(event) => { onPatch({ detail: event.target.value }) }}
              />
            </label>
          </>
        ) : stage.kind === 'switch' ? (
          <>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.routes')}</span>
              <textarea
                className={css.prefsTextarea} rows={3} spellCheck={false}
                placeholder={t('sc.field.routesHint')}
                value={stage.routes?.join('\n') ?? ''}
                onChange={(event) => { onPatch({ routes: event.target.value.split('\n').map(route => route.trim()).filter(route => route !== '') }) }}
              />
            </label>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.routeRule')}</span>
              <textarea
                className={css.prefsTextarea} rows={3} spellCheck={false}
                value={stage.run?.instruction ?? ''}
                onChange={(event) => { onPatch({ run: { instruction: event.target.value } }) }}
              />
            </label>
          </>
        ) : stage.kind === 'tool' ? (
          <label className={css.prefsField}>
            <span className={css.prefsFieldLabel}>{t('sc.field.command')}</span>
            <textarea
              className={css.prefsTextarea} rows={2} spellCheck={false}
              value={stage.command ?? ''}
              onChange={(event) => { onPatch({ command: event.target.value }) }}
            />
          </label>
        ) : stage.kind === 'notify' ? (
          <>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.noticeText')}</span>
              <textarea
                className={css.prefsTextarea} rows={3} spellCheck={false}
                value={stage.text ?? ''}
                onChange={(event) => { onPatch({ text: event.target.value }) }}
              />
            </label>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.webhook')}</span>
              <input
                className={css.taskTitleInput}
                value={stage.webhook ?? ''}
                placeholder="https://..."
                onChange={(event) => { onPatch({ webhook: event.target.value }) }}
              />
            </label>
          </>
        ) : (
          <>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.template')}</span>
              <textarea
                className={css.prefsTextarea} rows={5} spellCheck={false}
                value={stage.template ?? ''}
                onChange={(event) => { onPatch({ template: event.target.value }) }}
              />
            </label>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.persist')}</span>
              <input
                className={css.taskTitleInput}
                value={stage.persistDirectory ?? ''}
                onChange={(event) => { onPatch({ persistDirectory: event.target.value }) }}
              />
            </label>
            <label className={css.prefsField}>
              <span className={css.prefsFieldLabel}>{t('sc.field.profile')}</span>
              <input
                className={css.taskTitleInput}
                value={stage.profileFile ?? ''}
                placeholder="knowledge-profile.md"
                onChange={(event) => { onPatch({ profileFile: event.target.value }) }}
              />
            </label>
          </>
        )}
      </div>
      <div className={css.scStagePanelActions}>
        <button
          type="button"
          className={css.scenarioActionDanger}
          onClick={() => { if (window.confirm(t('sc.confirmStageDelete'))) onDelete() }}
        >
          {t('sc.deleteStage')}
        </button>
      </div>
    </div>
  )
}

/** Toolbar labels for adding each kind of node. */
const KIND_ADD_KEY: Record<StageRecord['kind'], BoardKey> = {
  discipline: 'sc.kind.discipline',
  agent: 'sc.kind.agent',
  gate: 'sc.kind.gate',
  persist: 'sc.kind.persist',
  human: 'sc.kind.human',
  switch: 'sc.kind.switch',
  tool: 'sc.kind.tool',
  notify: 'sc.kind.notify',
}

/** All addable kinds, in toolbar order. */
const ADDABLE_KINDS = ['discipline', 'agent', 'gate', 'human', 'switch', 'tool', 'notify', 'persist'] as const

/** Node data carried by the DAG canvas nodes. */
interface ScenarioNodeData extends Record<string, unknown> {
  readonly kind: StageRecord['kind']
  readonly title: string
  readonly meta: string
  readonly open: boolean
  readonly routes: readonly string[]
  readonly ghost?: 'in' | 'out'
}

/** One canvas node: kind badge + title + meta; gate carries PASS/FAIL outlets,
 * switch carries one outlet per configured route. */
function ScenarioFlowNode({ data }: NodeProps<Node<ScenarioNodeData>>): React.JSX.Element {
  const kindClass = data.kind === 'agent'
    ? css.stageNodeAgent
    : data.kind === 'gate'
      ? css.stageNodeGate
      : ''
  if (data.ghost !== undefined) {
    return (
      <div className={[css.scFlowNode, css.scFlowGhost, data.ghost === 'in' ? css.scFlowGhostIn : css.scFlowGhostOut].join(' ')}>
        {data.ghost === 'out'
          ? <Handle type="target" position={Position.Left} />
          : null}
        <span className={css.stageBadge}>{data.ghost === 'in' ? '入' : '出'}</span>
        <span className={css.stageTitle}>{data.title}</span>
        <span className={css.stageMeta}>{data.meta}</span>
        {data.ghost === 'in'
          ? <Handle type="source" position={Position.Right} />
          : null}
      </div>
    )
  }
  return (
    <div className={[css.scFlowNode, kindClass, data.open ? css.stageNodeActive : ''].join(' ')}>
      <Handle type="target" position={Position.Left} />
      <span className={css.stageBadge}>{KIND_LABEL[data.kind]}</span>
      <span className={css.stageTitle}>{data.title}</span>
      <span className={css.stageMeta}>{data.meta}</span>
      {data.kind === 'gate' ? (
        <>
          <Handle type="source" position={Position.Right} id="pass" style={{ top: '28%' }} />
          <Handle type="source" position={Position.Right} id="fail" style={{ top: '72%' }} />
          <span className={css.scFlowPortLabel} style={{ top: '18%' }}>PASS</span>
          <span className={css.scFlowPortLabel} style={{ top: '62%' }}>FAIL</span>
        </>
      ) : data.kind === 'switch' ? (
        <>
          {data.routes.length === 0 ? (
            <Handle type="source" position={Position.Right} id="out" />
          ) : data.routes.map((route, index) => (
            <Handle
              key={route}
              type="source"
              position={Position.Right}
              id={route}
              style={{ top: `${Math.round(((index + 1) / (data.routes.length + 1)) * 100)}%` }}
            />
          ))}
          {data.routes.map((route, index) => (
            <span
              key={route}
              className={css.scFlowPortLabel}
              style={{ top: `${Math.max(0, Math.round(((index + 1) / (data.routes.length + 1)) * 100) - 10)}%` }}
            >
              {route}
            </span>
          ))}
        </>
      ) : (
        <Handle type="source" position={Position.Right} id="out" />
      )}
    </div>
  )
}

const NODE_TYPES = { scenario: ScenarioFlowNode }

/**
 * Custom edge: forward edges are orthogonal steps; back edges (target left of
 * the source, e.g. gate FAIL → rework loop) dip below both nodes so they never
 * cross the main flow. The tag rides the lowest segment instead of sitting on
 * top of other edges.
 */
function ScenarioEdge({ id, source, target, sourceX, sourceY, targetX, targetY, label, style, markerEnd }: EdgeProps): React.JSX.Element {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const sourceBottom = sourceY + (sourceNode?.measured.height ?? 0) / 2 + 16
  const targetBottom = targetY + (targetNode?.measured.height ?? 0) / 2 + 16
  const isBack = targetX < sourceX
  let path: string
  let labelX: number
  let labelY: number
  if (isBack) {
    const dip = Math.max(sourceBottom, targetBottom) + 46
    const out = 28
    path = [
      `M ${sourceX} ${sourceY}`,
      `L ${sourceX + out} ${sourceY}`,
      `L ${sourceX + out} ${dip}`,
      `L ${targetX - out} ${dip}`,
      `L ${targetX - out} ${targetY}`,
      `L ${targetX} ${targetY}`,
    ].join(' ')
    labelX = (sourceX + targetX) / 2
    labelY = dip
  } else {
    ;[path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, borderRadius: 12, offset: 18 })
  }
  const stroke = typeof style?.stroke === 'string' ? style.stroke : '#8b949e'
  return (
    <>
      <BaseEdge id={id} path={path} style={style} {...(markerEnd === undefined ? {} : { markerEnd })} />
      {label === undefined || label === '' ? null : (
        <EdgeLabelRenderer>
          <div
            className={css.scEdgeTag}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, color: stroke, borderColor: stroke }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const EDGE_TYPES = { scenario: ScenarioEdge }

/**
 * Forward edges for layering: `next`, gate `pass`, and switch routes. Gate
 * `fail` edges are rework loops / fallback paths, so they stay out of the
 * layer graph and get drawn as back-connections instead of deadlocking the
 * layout.
 */
function forwardTargets(stage: StageRecord): readonly string[] {
  if (stage.kind === 'switch') {
    return [...(stage.next ?? []), ...Object.values(stage.branch ?? {}).flat()]
  }
  return [
    ...(stage.next ?? []),
    ...(stage.branch?.pass ?? []),
  ]
}

/**
 * Auto-layout (Sugiyama-lite): Kahn-style layering (cycle members land in the
 * final layer instead of diverging), lane order by upstream barycenter, each
 * layer centered vertically. Left-to-right flow, no overlaps, fewer crossings.
 */
function layoutStages(stages: readonly StageRecord[]): readonly StageRecord[] {
  if (stages.length === 0) return stages
  const byId = new Map(stages.map(stage => [stage.id, stage]))
  // Kahn layering: repeatedly peel off stages whose incoming edges are all placed.
  const layers = new Map<string, number>()
  const pending = new Map<string, number>()
  for (const stage of stages) {
    const count = stages.filter(source => source.id !== stage.id && forwardTargets(source).includes(stage.id)).length
    pending.set(stage.id, count)
  }
  let frontier = stages.filter(stage => (pending.get(stage.id) ?? 0) === 0).map(stage => stage.id)
  let layer = 0
  while (frontier.length > 0) {
    for (const id of frontier) layers.set(id, layer)
    const next: string[] = []
    for (const id of frontier) {
      const stage = byId.get(id)
      for (const target of stage === undefined ? [] : forwardTargets(stage)) {
        if (target === id || !pending.has(target) || layers.has(target)) continue
        const rest = (pending.get(target) ?? 1) - 1
        pending.set(target, rest)
        if (rest === 0) next.push(target)
      }
    }
    frontier = [...new Set(next)]
    layer += 1
  }
  // Anything left sits on a user-drawn cycle: park it after the DAG.
  for (const stage of stages) {
    if (!layers.has(stage.id)) layers.set(stage.id, layer)
  }
  const maxLayer = Math.max(...Array.from(layers.values()))
  // Lane order per layer: roots keep record order, others sort by mean upstream lane index.
  const laneIndexOf = new Map<string, number>()
  for (let layer = 0; layer <= maxLayer; layer += 1) {
    const members = stages.filter(stage => (layers.get(stage.id) ?? 0) === layer)
    if (layer > 0) {
      const bary = (id: string): number => {
        const sources = stages.filter(source => source.id !== id && forwardTargets(source).includes(id))
        const indexes = sources.map(source => laneIndexOf.get(source.id)).filter((value): value is number => value !== undefined)
        return indexes.length === 0 ? 0 : indexes.reduce((sum, value) => sum + value, 0) / indexes.length
      }
      members.sort((a, b) => bary(a.id) - bary(b.id))
    }
    members.forEach((stage, index) => { laneIndexOf.set(stage.id, index) })
  }
  const maxLanes = Math.max(...Array.from(new Set(stages.map(stage => layers.get(stage.id) ?? 0))).map(layer => stages.filter(stage => (layers.get(stage.id) ?? 0) === layer).length))
  const LAYER_GAP = 260
  const LANE_GAP = 120
  const TOP = 60
  return stages.map(stage => {
    const layer = layers.get(stage.id) ?? 0
    const lane = laneIndexOf.get(stage.id) ?? 0
    const laneCount = stages.filter(item => (layers.get(item.id) ?? 0) === layer).length
    const y = TOP + ((maxLanes - laneCount) / 2) * LANE_GAP + lane * LANE_GAP
    return { ...stage, position: { x: 40 + layer * LAYER_GAP, y: Math.round(y) } }
  })
}

/** Ghost boundary node ids (never persisted, never interactive). */
const FLOW_IN_ID = '__flow_in'
const FLOW_OUT_ID = '__flow_out'
const GHOST_EDGE_STYLE = { stroke: '#6b7280', strokeDasharray: '6 5', strokeWidth: 1.4 }

/** Canvas rows derived from stage records, wrapped by an entry and an exit
 * ghost so the user can see where input enters and output leaves. */
function canvasNodes(stages: readonly StageRecord[], openId: string | undefined): Node<ScenarioNodeData>[] {
  const real: Node<ScenarioNodeData>[] = stages.map((stage, index) => ({
    id: stage.id,
    position: stage.position ?? { x: 40, y: 40 + index * 110 },
    data: {
      kind: stage.kind,
      title: stage.title,
      meta: stage.kind === 'agent'
        ? `${whenLabel(stage)} · 最多 ${stage.run?.maxRuns ?? 1} 次`
        : stage.kind === 'gate'
          ? `${whenLabel(stage)} · 打回上限 ${stage.rework?.maxRework ?? 2} 次`
          : stage.kind === 'human'
            ? '到达时弹卡片确认'
            : stage.kind === 'switch'
              ? (stage.routes ?? []).join(' / ')
              : stage.kind === 'tool'
                ? stage.command ?? ''
                : stage.kind === 'notify'
                  ? stage.text ?? ''
                  : whenLabel(stage),
      open: stage.id === openId,
      routes: stage.routes ?? [],
    },
    type: 'scenario',
  }))
  const xs = real.map(node => node.position.x)
  const ys = real.map(node => node.position.y)
  const minX = xs.length > 0 ? Math.min(...xs) : 40
  const maxX = xs.length > 0 ? Math.max(...xs) : 40
  const midY = ys.length > 0 ? (Math.min(...ys) + Math.max(...ys)) / 2 : 40
  return [
    {
      id: FLOW_IN_ID,
      position: { x: minX - 280, y: midY },
      data: { kind: 'discipline', title: '用户输入 · 任务会话', meta: '拖右侧端口到节点 = 设为流程起点', open: false, routes: [], ghost: 'in' },
      type: 'scenario',
      draggable: false,
      deletable: false,
    },
    ...real,
    {
      id: FLOW_OUT_ID,
      position: { x: maxX + 280, y: midY },
      data: { kind: 'persist', title: '流程出口 · 回注/落盘', meta: '把节点连到左侧端口 = 设为流程终点', open: false, routes: [], ghost: 'out' },
      type: 'scenario',
      draggable: false,
      deletable: false,
    },
  ]
}

/** Canvas edges derived from `next` and `branch` references, wrapped by
 * dashed boundary edges (entry → roots, sinks → exit). */
function canvasEdges(stages: readonly StageRecord[]): Edge[] {
  const edges: Edge[] = []
  const incoming = new Set<string>()
  for (const stage of stages) {
    for (const id of [...(stage.next ?? []), ...Object.values(stage.branch ?? {}).flat()]) incoming.add(id)
  }
  for (const stage of stages) {
    if (!incoming.has(stage.id)) {
      edges.push({
        id: `e:${FLOW_IN_ID}:out:${stage.id}`,
        source: FLOW_IN_ID,
        target: stage.id,
        sourceHandle: 'out',
        type: 'scenario',
        style: GHOST_EDGE_STYLE,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#6b7280' },
      })
    }
    const hasExit = (stage.next ?? []).length > 0 || Object.keys(stage.branch ?? {}).length > 0
    if (!hasExit) {
      edges.push({
        id: `e:${stage.id}:out:${FLOW_OUT_ID}`,
        source: stage.id,
        target: FLOW_OUT_ID,
        sourceHandle: 'out',
        type: 'scenario',
        style: GHOST_EDGE_STYLE,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#6b7280' },
      })
    }
  }
  for (const stage of stages) {
    for (const target of stage.next ?? []) {
      edges.push({
        id: `e:${stage.id}:out:${target}`,
        source: stage.id,
        target,
        sourceHandle: stage.kind === 'gate' ? 'out' : 'out',
        type: 'scenario',
        markerEnd: { type: MarkerType.ArrowClosed },
      })
    }
    for (const target of stage.branch?.pass ?? []) {
      edges.push({
        id: `e:${stage.id}:pass:${target}`,
        source: stage.id,
        target,
        sourceHandle: 'pass',
        type: 'scenario',
        label: 'PASS',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#16a34a' },
        style: { stroke: '#16a34a', strokeWidth: 1.8 },
      })
    }
    for (const target of stage.branch?.fail ?? []) {
      edges.push({
        id: `e:${stage.id}:fail:${target}`,
        source: stage.id,
        target,
        sourceHandle: 'fail',
        type: 'scenario',
        label: 'FAIL',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#dc2626' },
        style: { stroke: '#dc2626', strokeWidth: 1.8 },
      })
    }
    if (stage.kind === 'switch') {
      for (const [route, targets] of Object.entries(stage.branch ?? {})) {
        if (route === 'pass' || route === 'fail') continue
        for (const target of targets) {
          edges.push({
            id: `e:${stage.id}:${route}:${target}`,
            source: stage.id,
            target,
            sourceHandle: route,
            type: 'scenario',
            label: route,
            markerEnd: { type: MarkerType.ArrowClosed, color: '#8b5cf6' },
            style: { stroke: '#8b5cf6', strokeWidth: 1.8 },
          })
        }
      }
    }
  }
  return edges
}

/**
 * The DAG canvas: nodes drag (position persists), connecting two ports creates
 * the edge in the stage records, deleting removes it, clicking opens the
 * editor. All mutations flow back through `onStagesChange`.
 */
function ScenarioCanvas({ stages, openId, layoutEpoch, onOpen, onStagesChange, t }: {
  stages: readonly StageRecord[]
  openId: string | undefined
  layoutEpoch: number
  onOpen: (id: string) => void
  onStagesChange: (next: readonly StageRecord[]) => void
  t: ScenariosT
}): React.JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState(canvasNodes(stages, openId))
  const [edges, setEdges, onEdgesChange] = useEdgesState(canvasEdges(stages))

  // External stage edits (property panel, toolbar add) resync the canvas.
  // Selection must survive the rebuild: pressing Delete removes exactly the
  // selected nodes/edges, and React Flow reads `selected` off these objects.
  useEffect(() => {
    setNodes(current => canvasNodes(stages, openId).map(node => {
      if (node.id === FLOW_IN_ID || node.id === FLOW_OUT_ID) return node
      const existing = current.find(item => item.id === node.id)
      if (existing === undefined) return node
      const stagePosition = stages.find(stage => stage.id === node.id)?.position
      return { ...node, position: stagePosition ?? existing.position, ...(existing.selected === true ? { selected: true } : {}) }
    }))
    setEdges(current => canvasEdges(stages).map(edge => {
      const existing = current.find(item => item.id === edge.id)
      return existing === undefined ? edge : { ...edge, ...(existing.selected === true ? { selected: true } : {}) }
    }))
  }, [stages, openId, setNodes, setEdges])

  const commitPositions = (updated: readonly Node[]): void => {
    onStagesChange(stages.map(stage => {
      const node = updated.find(item => item.id === stage.id)
      if (node === undefined) return stage
      if (stage.position !== undefined && stage.position.x === node.position.x && stage.position.y === node.position.y) return stage
      return { ...stage, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } }
    }))
  }

  const onConnect = (connection: Connection): void => {
    const source = connection.source
    const target = connection.target
    if (source === null || target === null || source === target) return
    if (source === FLOW_IN_ID) {
      // Entry → node: make the target a flow root (strip incoming references);
      // the dashed entry edge then points at it automatically.
      onStagesChange(stages.map(stage => {
        const next = (stage.next ?? []).filter(id => id !== target)
        if (stage.branch === undefined) return { ...stage, next }
        const branch: { [route: string]: string[] } = {}
        for (const [route, targets] of Object.entries(stage.branch)) {
          const rest = targets.filter(id => id !== target)
          if (rest.length > 0) branch[route] = [...rest]
        }
        return { ...stage, next, branch }
      }))
      return
    }
    if (target === FLOW_OUT_ID) {
      // Node → exit: make the source a flow sink (strip outgoing edges).
      onStagesChange(stages.map(item => {
        if (item.id !== source) return item
        const stripped: StageRecord = { ...item, next: [] }
        delete (stripped as { branch?: unknown }).branch
        return stripped
      }))
      return
    }
    const stage = stages.find(item => item.id === source)
    if (stage === undefined) return
    const handle = connection.sourceHandle ?? 'out'
    if (handle !== 'out') {
      // pass/fail on gates, route names on switches.
      const current = stage.branch?.[handle] ?? []
      if (current.includes(target)) return
      const branch = { ...(stage.branch ?? {}), [handle]: [...current, target] }
      onStagesChange(stages.map(item => item.id === source ? { ...item, branch } : item))
    } else {
      if ((stage.next ?? []).includes(target)) return
      onStagesChange(stages.map(item => item.id === source ? { ...item, next: [...(item.next ?? []), target] } : item))
    }
  }

  /** Edge ids we generate: `e:<source>:<handle>:<target>`; ghost edges use
   * `__flow_*` ids and must never mutate the stage records. */
  const isRealEdge = (edge: Edge): boolean =>
    !edge.id.startsWith('e:__flow_') && edge.source.startsWith('__') === false && edge.target.startsWith('__') === false

  const onEdgesDelete = (deleted: readonly Edge[]): void => {
    let next = [...stages]
    for (const edge of deleted) {
      if (!isRealEdge(edge)) continue
      const parts = edge.id.split(':')
      const source = parts[1]
      const handle = parts[2]
      const target = parts[3]
      if (source === undefined || handle === undefined || target === undefined) continue
      next = next.map(stage => {
        if (stage.id !== source) return stage
        if (handle !== 'out') {
          const list: readonly string[] = stage.branch?.[handle] ?? []
          const rest = list.filter(id => id !== target)
          const branch: { [route: string]: string[] } = {}
          for (const [route, targets] of Object.entries(stage.branch ?? {})) branch[route] = [...targets]
          if (rest.length === 0) delete branch[handle]
          else branch[handle] = [...rest]
          return { ...stage, branch }
        }
        return { ...stage, next: (stage.next ?? []).filter(id => id !== target) }
      })
    }
    onStagesChange(next)
  }

  const onNodesDelete = (deleted: readonly Node[]): void => {
    const ids = new Set(deleted.map(node => node.id))
    onStagesChange(stages
      .filter(stage => !ids.has(stage.id))
      .map(stage => {
        const next = (stage.next ?? []).filter(id => !ids.has(id))
        if (stage.branch === undefined) return { ...stage, next }
        const branch: { [route: string]: string[] } = {}
        for (const [route, targets] of Object.entries(stage.branch)) {
          const rest = targets.filter(id => !ids.has(id))
          if (rest.length > 0) branch[route] = [...rest]
        }
        return { ...stage, next, branch }
      }))
  }

  return (
    // Focusable wrapper: clicking anywhere in the canvas (capture phase —
    // React Flow stops node mousedown propagation) moves focus away from
    // inputs like the chat composer, otherwise React Flow ignores Delete
    // presses that land inside an input DOM node.
    <div
      className={css.scCanvas}
      tabIndex={0}
      aria-label={t('sc.canvas.label')}
      onMouseDownCapture={(event) => { event.currentTarget.focus() }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onEdgeDoubleClick={(_event, edge) => { if (isRealEdge(edge)) onEdgesDelete([edge]) }}
        onNodeDragStop={(_event, node) => { commitPositions([node]) }}
        onNodeClick={(_event, node) => { if (!node.id.startsWith('__')) onOpen(node.id) }}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
        <CanvasFitView epoch={layoutEpoch} />
      </ReactFlow>
    </div>
  )
}

/**
 * Reframes the graph after each auto-layout. Must live inside `<ReactFlow>`
 * so `useReactFlow` runs within the flow's provider.
 */
function CanvasFitView({ epoch }: { readonly epoch: number }): React.JSX.Element | null {
  const { fitView } = useReactFlow()
  useEffect(() => {
    if (epoch > 0) void fitView({ padding: 0.25, duration: 400 })
  }, [epoch, fitView])
  return null
}

/** Overlay editor for one scenario record (or a new scenario). */
function ScenarioEditor({ scenario, onClose, onSaved, t }: {
  scenario: ScenarioRecord | undefined
  onClose: () => void
  onSaved: () => void
  t: ScenariosT
}): React.JSX.Element {
  const [name, setName] = useState(scenario?.name ?? '')
  const [idDraft, setIdDraft] = useState(scenario === undefined ? '' : scenario.id)
  const [description, setDescription] = useState(scenario?.description ?? '')
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

  const save = async (): Promise<void> => {
    if (name.trim() === '') return
    const id = (idDraft.trim() !== '' ? idDraft : name).trim().replaceAll(/\s+/g, '-').replaceAll('/', '-')
    if (id === '') return
    setSaving(true)
    try {
      await postScenarios({
        op: 'save',
        scenario: {
          ...scenario,
          id,
          name,
          description,
          instructions: scenario?.instructions ?? { clarify: '', loop: '', verify: '' },
          outputs: scenario?.outputs ?? { template: '', persistDirectory: 'tasks/{{task.dirName}}/' },
        },
      })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return createPortal((
    <div className={css.prefsOverlay} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }}>
      <div className={css.prefsDialog} role="dialog" aria-modal="true" aria-label={t('sc.edit')}>
        <h2 className={css.prefsHeading}>
          {scenario === undefined ? t('sc.new') : `${t('sc.edit')} · ${scenario.name}`}
        </h2>
        <label className={css.prefsField}>
          <span className={css.prefsFieldLabel}>{t('sc.field.name')}</span>
          <input
            className={css.taskTitleInput}
            value={name}
            onChange={(event) => { setName(event.target.value) }}
          />
        </label>
        {scenario === undefined ? (
          <label className={css.prefsField}>
            <span className={css.prefsFieldLabel}>{t('sc.field.scenarioId')}</span>
            <input
              className={css.taskTitleInput}
              value={idDraft}
              placeholder={name.trim() === '' ? 'test' : name.trim().replaceAll(/\s+/g, '-')}
              onChange={(event) => { setIdDraft(event.target.value) }}
            />
          </label>
        ) : null}
        <label className={css.prefsField}>
          <span className={css.prefsFieldLabel}>{t('sc.field.description')}</span>
          <textarea
            className={css.prefsTextarea} value={description} rows={3} spellCheck={false}
            onChange={(event) => { setDescription(event.target.value) }}
          />
        </label>
        <p className={css.prefsHint}>{t('sc.editorHint')}</p>
        <div className={css.prefsActions}>
          <button type="button" className={css.prefsPrimary} disabled={saving} onClick={() => { void save() }}>
            {t('task.save')}
          </button>
          <button type="button" className={css.prefsSecondary} onClick={onClose}>
            {t('task.cancel')}
          </button>
        </div>
      </div>
    </div>
  ), document.body)
}
