// Drives a real Claude Code TUI in tmux and records every screen state it shows.
// usage: node record.mjs storyboard.mjs out.json   (tmux session "rec" must already run claude; see record.sh)
// Each frame is `tmux capture-pane -e -p` (text + SGR colours) plus the scripted pointer position.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [, , boardFile, out] = process.argv
const { steps, cols, rows } = (await import(path.resolve(boardFile))).default
const T = 'rec'
const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf8' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const start = Date.now()
const frames = []
let pointer = null // {x, y, down, button}
let last = ''
function grab() {
  const screen = tmux('capture-pane', '-t', T, '-e', '-N', '-p')
  const key = screen + JSON.stringify(pointer)
  if (key === last) return
  last = key
  frames.push({ t: Date.now() - start, screen, pointer: pointer && { ...pointer } })
}
const timer = setInterval(grab, 60)
const mouse = (b, x, y, up) => tmux('send-keys', '-t', T, '-l', `\x1b[<${b};${x};${y}${up ? 'm' : 'M'}`)

async function moveTo(x, y, ms = 450) {
  const from = pointer ?? { x: Math.round(cols * 0.75), y: rows - 4 }
  const n = Math.max(1, Math.round(ms / 30))
  for (let i = 1; i <= n; i++) {
    const k = i / n, e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
    pointer = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e, down: false }
    if (Number.isInteger(Math.round(pointer.x))) mouse(35, Math.round(pointer.x), Math.round(pointer.y))
    await sleep(30)
  }
  pointer = { x, y, down: false }
}
async function click(x, y, button = 0) {
  await moveTo(x, y)
  await sleep(150)
  pointer = { x, y, down: true, button }
  mouse(button, x, y); await sleep(90); mouse(button, x, y, true)
  await sleep(220)
  pointer = { x, y, down: false }
}
/** Finds `text` on screen, returns its 1-based cell; `nth` picks among matches; `after` limits to columns at or right of it. */
function find(text, { nth = 0, minCol = 0 } = {}) {
  const lines = tmux('capture-pane', '-t', T, '-p').split('\n')
  const hits = []
  lines.forEach((line, y) => {
    let col = 0, cells = []
    for (const ch of line) { cells.push([col, ch]); col += wide(ch.codePointAt(0)) ? 2 : 1 }
    const s = [...line]
    for (let i = 0; i < s.length; i++) {
      if (s.slice(i, i + [...text].length).join('') === text && cells[i][0] >= minCol) hits.push({ x: cells[i][0] + 1, y: y + 1 })
    }
  })
  if (!hits[nth]) throw new Error(`not on screen: ${text}`)
  return hits[nth]
}
export const wide = cp => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)

const api = {
  sleep,
  keys: async (...k) => { for (const key of k) { tmux('send-keys', '-t', T, key); await sleep(260) } },
  type: async (text, ms = 55) => { for (const ch of text) { tmux('send-keys', '-t', T, '-l', ch); await sleep(ms) } },
  moveTo, click,
  clickText: async (text, o = {}) => { const p = find(text, o); await click(p.x + (o.dx ?? 1), p.y, o.button ?? 0) },
  hoverText: async (text, o = {}) => { const p = find(text, o); await moveTo(p.x + (o.dx ?? 1), p.y) },
  hide: () => { pointer = null },
  find,
}
const marks = []
for (const step of steps) { marks.push({ t: Date.now() - start, label: step.name }); await step.run(api) }
clearInterval(timer)
grab()
fs.writeFileSync(out, JSON.stringify({ cols, rows, end: Date.now() - start, marks, frames }))
console.log(`${frames.length} frames, ${((Date.now() - start) / 1000).toFixed(1)}s`)
