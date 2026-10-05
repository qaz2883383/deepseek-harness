import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { scanZstdFrames, decompressZstdFrame } from '../packages/session/session-persistence-jsonl/src/zstd.ts'

const needle = process.argv[2] ?? 'session-e738a3f4'
const base = 'D:/2026/涅槃/AGENT/workbench-test/dsh-home/sessions'

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (full.endsWith('.zstd')) yield full
  }
}

for (const file of walk(base)) {
  if (!file.includes(needle)) continue
  const buffer = readFileSync(file)
  const { frames } = scanZstdFrames(buffer)
  let text = ''
  for (const frame of frames) {
    text += (await decompressZstdFrame(buffer.subarray(frame.start, frame.end))).toString('utf8')
  }
  for (const line of text.split('\n').filter(line => line.trim() !== '')) {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      console.log('UNPARSEABLE', line.slice(0, 120))
      continue
    }
    const whole = JSON.stringify(event)
    const flags = [
      whole.includes('Current runtime context') ? 'RTC' : '',
      whole.includes('Current task for this conversation') ? 'TASK' : '',
      whole.includes('reply_style') ? 'PREF' : '',
    ].filter(flag => flag !== '').join(',')
    console.log(`${String(event.type ?? event.event ?? '?').slice(0, 48).padEnd(48)} ${flags.padEnd(12)} ${whole.slice(0, 200)}`)
  }
}
