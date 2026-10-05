import { readFileSync } from 'node:fs'
import { scanZstdFrames, decompressZstdFrame } from '../packages/session/session-persistence-jsonl/src/zstd.ts'

const file = process.argv[2] ?? ''
const buffer = readFileSync(file)
const { frames } = scanZstdFrames(buffer)
let text = ''
for (const frame of frames) {
  text += (await decompressZstdFrame(buffer.subarray(frame.start, frame.end))).toString('utf8')
}
let last = ''
for (const line of text.split('\n').filter(line => line.trim() !== '')) {
  const event = JSON.parse(line) as { type?: string; data?: { content?: { text?: string }[] } }
  if (event.type !== 'user/message') continue
  const body = event.data?.content?.map(part => part.text ?? '').join('') ?? ''
  if (body.includes('Current runtime context')) last = body
}
console.log(last)
