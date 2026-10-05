import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanZstdFrames, decompressZstdFrame } from '../packages/session/session-persistence-jsonl/src/zstd.ts'

async function decompressAll(buffer: Buffer): Promise<string> {
  const { frames } = scanZstdFrames(buffer)
  const parts: string[] = []
  for (const frame of frames) {
    parts.push((await decompressZstdFrame(buffer.subarray(frame.start, frame.end))).toString('utf8'))
  }
  return parts.join('')
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

const base = 'D:/2026/涅槃/AGENT/workbench-test/dsh-home/sessions'
const tasks = JSON.parse(readFileSync('D:/2026/涅槃/AGENT/workbench-test/dsh-home/tasks/tasks.json', 'utf8')) as { tasks: { sessions: string[]; title: string }[] }
const bound = new Map<string, string>()
for (const task of tasks.tasks) for (const session of task.sessions) bound.set(session, task.title)

const rows: object[] = []
for (const file of walk(base)) {
  if (!file.endsWith('.zstd')) continue
  const id = file.split(/[\\/]/).at(-2) ?? ''
  let text = ''
  try {
    text = await decompressAll(readFileSync(file))
  } catch (error) {
    rows.push({ id, error: String(error) })
    continue
  }
  const lines = text.split('\n').filter(line => line.trim() !== '')
  // True tool usage only: request/header carries every tool schema, so a plain
  // text search would flag every session that merely loaded the tasks plugin.
  const calls = new Set<string>()
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; data?: { name?: string } }
      if (event.type === 'tool/call' && typeof event.data?.name === 'string') calls.add(event.data.name)
    } catch { /* unparseable line: skipped */ }
  }
  rows.push({
    mtime: statSync(file).mtime.toISOString().slice(5, 16),
    id: id.slice(0, 16),
    events: lines.length,
    brief: text.includes('Current task for this conversation') ? 'Y' : '-',
    create: calls.has('task_create') ? 'Y' : '-',
    update: calls.has('task_update') ? 'Y' : '-',
    start: calls.has('task_start') ? 'Y' : '-',
    bound: bound.get(id) ?? 'NONE',
  })
}
rows.sort((left: { mtime?: string }, right: { mtime?: string }) => String(right.mtime).localeCompare(String(left.mtime)))
for (const row of rows) console.log(JSON.stringify(row))
