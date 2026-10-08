// Turns a record.mjs capture into PNG frames, then MP4 and GIF with ffmpeg.
// usage: node render.mjs capture.json outdir [--gif-width 960]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim() + '/')
const { chromium } = require('playwright')

const [, , capFile, outDir, ...rest] = process.argv
const opt = k => { const i = rest.indexOf(k); return i < 0 ? null : rest[i + 1] }
const gifWidth = Number(opt('--gif-width') ?? 960)
const cap = JSON.parse(fs.readFileSync(capFile, 'utf8'))
const { cols, rows } = cap
fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true })

const wide = cp => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)
// Windows Terminal "Campbell".
const BASE = ['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc', '#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2']
const FG = '#cccccc', BG = '#0c0c0c'
function c256(n) {
  if (n < 16) return BASE[n]
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})` }
  n -= 16; const s = [0, 95, 135, 175, 215, 255]
  return `rgb(${s[Math.floor(n / 36)]},${s[Math.floor(n / 6) % 6]},${s[n % 6]})`
}

/** One captured screen → rows of cells {ch, w, fg, bg, b, d, i, u, s}. */
function parse(screen) {
  const lines = screen.replace(/\n$/, '').split('\n')
  let st = {} // tmux carries SGR state from one line to the next
  return Array.from({ length: rows }, (_, y) => {
    const line = lines[y] ?? ''
    const cells = []
    const re = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^\[\]]|([\s\S])/gu
    let m
    while ((m = re.exec(line))) {
      if (m[1] !== undefined) {
        const p = m[1] === '' ? [0] : m[1].split(/[;:]/).map(Number)
        for (let k = 0; k < p.length; k++) {
          const v = p[k]
          if (v === 0) st = {}
          else if (v === 1) st.b = 1; else if (v === 2) st.d = 1; else if (v === 3) st.i = 1; else if (v === 4) st.u = 1
          else if (v === 7) st.r = 1; else if (v === 9) st.s = 1
          else if (v === 22) { delete st.b; delete st.d } else if (v === 23) delete st.i; else if (v === 24) delete st.u
          else if (v === 27) delete st.r; else if (v === 29) delete st.s
          else if (v >= 30 && v <= 37) st.fg = BASE[v - 30]; else if (v >= 90 && v <= 97) st.fg = BASE[v - 82]
          else if (v >= 40 && v <= 47) st.bg = BASE[v - 40]; else if (v >= 100 && v <= 107) st.bg = BASE[v - 92]
          else if (v === 39) delete st.fg; else if (v === 49) delete st.bg
          else if (v === 38 || v === 48) {
            const key = v === 38 ? 'fg' : 'bg'
            if (p[k + 1] === 5) { st[key] = c256(p[k + 2]); k += 2 }
            else if (p[k + 1] === 2) { st[key] = `rgb(${p[k + 2]},${p[k + 3]},${p[k + 4]})`; k += 4 }
          }
        }
      } else if (m[2] !== undefined) {
        const w = wide(m[2].codePointAt(0)) ? 2 : 1
        cells.push({ ch: m[2], w, ...st })
        if (w === 2) cells.push(null)
      }
    }
    while (cells.length < cols) cells.push({ ch: ' ', w: 1 })
    return cells.slice(0, cols)
  })
}
const text = row => row.map(c => (c ? c.ch : '')).join('')

/** Drops the cloud container's own startup warnings (auth, remote settings, auto-update); they are not the plugin's. */
function maskHostWarnings(grid) {
  const divider = text(grid[1]).indexOf('│')
  const right = divider < 0 ? cols : divider
  const left = y => text(grid[y].slice(0, right))
  const blank = y => { for (let x = 0; x < right; x++) grid[y][x] = { ch: ' ', w: 1 } }
  for (let y = 0; y < rows; y++) if (/Auto-update failed|Use alt\+t to toggle/.test(left(y))) blank(y)
  let a = -1, b = -1
  for (let y = 0; y < rows; y++) {
    if (a < 0 && /^⚠ /.test(left(y))) a = y
    if (a >= 0 && y > a && (/^⚠ /.test(left(y)) || /^\s{2}\S/.test(left(y)))) b = y
    else if (a >= 0 && y > a) break
  }
  if (a < 0) return grid
  if (b < 0) b = a
  let end = rows - 1
  for (let y = b + 1; y < rows; y++) if (/⌗|^─{20}/.test(left(y))) { end = y - 1; break }
  const k = b - a + 1
  for (let y = a; y <= end; y++) {
    if (y + k <= end) for (let x = 0; x < right; x++) grid[y][x] = grid[y + k][x]
    else blank(y)
  }
  return grid
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function rowHtml(row) {
  let html = ''
  for (const c of row) {
    if (!c) continue
    let fg = c.fg ?? FG, bg = c.bg
    if (c.r) { const t = fg; fg = bg ?? BG; bg = t }
    const st = [`color:${fg}`]
    if (bg) st.push(`background:${bg}`)
    if (c.b) st.push('font-weight:700')
    if (c.d) st.push('opacity:.6')
    if (c.i) st.push('font-style:italic')
    if (c.u || c.s) st.push(`text-decoration:${c.u ? 'underline' : ''} ${c.s ? 'line-through' : ''}`)
    html += `<i class="${c.w === 2 ? 'w' : 'c'}" style="${st.join(';')}">${c.ch === ' ' ? '&nbsp;' : esc(c.ch)}</i>`
  }
  return `<div class="r">${html}</div>`
}

const CW = 9, LH = 19
const page0 = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#1b1f27}
#win{position:absolute;left:28px;top:24px;border-radius:10px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.07);background:${BG}}
#bar{height:34px;background:#202020;display:flex;align-items:center;gap:8px;padding:0 14px;font:13px "Segoe UI","DejaVu Sans",sans-serif;color:#aaa}
#bar b{width:12px;height:12px;border-radius:50%;display:inline-block}
#bar span{margin-left:10px}
#term{position:relative;padding:10px 12px;font:15px/${LH}px "DejaVu Sans Mono","WenQuanYi Zen Hei Mono",monospace;width:${cols * CW}px;height:${rows * LH}px;box-sizing:content-box}
.r{height:${LH}px;white-space:pre;display:flex}
i{font-style:normal;display:inline-block;height:${LH}px;overflow:visible;text-align:left}
i.c{width:${CW}px} i.w{width:${2 * CW}px;font-family:"WenQuanYi Zen Hei Mono",monospace;font-size:17px;letter-spacing:-.5px}
#ptr{position:absolute;width:22px;height:22px;pointer-events:none;z-index:9;filter:drop-shadow(0 1px 2px rgba(0,0,0,.7))}
#ring{position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid rgba(255,214,102,.95);background:rgba(255,214,102,.18);z-index:8;display:none}
#cap{position:absolute;left:28px;right:28px;height:44px;display:flex;align-items:center;justify-content:center;font:600 18px "WenQuanYi Zen Hei","DejaVu Sans",sans-serif;color:#e8e8e8;letter-spacing:.5px}
#cap em{font-style:normal;color:#8ab4ff;margin-right:12px;font-weight:700}
</style><div id="win"><div id="bar"><b style="background:#ff5f57"></b><b style="background:#febc2e"></b><b style="background:#28c840"></b><span>claude — ~/console</span></div><div id="term"><div id="g"></div><div id="ring"></div><svg id="ptr" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.3 19.2 L10.4 12.8 L16.5 12.8 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg></div></div><div id="cap"></div>`

const W = cols * CW + 24 + 56, H = rows * LH + 20 + 34 + 24 + 64
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
await page.setContent(page0)
await page.evaluate(([H]) => { document.getElementById('cap').style.top = (H - 58) + 'px' }, [H])

const caption = t => { let c = null; for (const m of cap.marks) if (m.t <= t + 1) c = m; return c?.label ?? '' }
const list = []
let n = 0
for (let k = 0; k < cap.frames.length; k++) {
  const f = cap.frames[k]
  const grid = maskHostWarnings(parse(f.screen))
  const html = grid.map(rowHtml).join('')
  const p = f.pointer
  await page.evaluate(([html, p, cw, lh, label]) => {
    document.getElementById('g').innerHTML = html
    const ptr = document.getElementById('ptr'), ring = document.getElementById('ring')
    if (!p) { ptr.style.display = 'none'; ring.style.display = 'none' }
    else {
      const x = 12 + (p.x - 0.5) * cw, y = 10 + (p.y - 0.5) * lh
      ptr.style.display = 'block'; ptr.style.left = (x - 3) + 'px'; ptr.style.top = (y - 2) + 'px'
      ring.style.display = p.down ? 'block' : 'none'; ring.style.left = x + 'px'; ring.style.top = y + 'px'
      ring.style.borderColor = p.button === 2 ? 'rgba(138,180,255,.95)' : 'rgba(255,214,102,.95)'
      ring.style.background = p.button === 2 ? 'rgba(138,180,255,.18)' : 'rgba(255,214,102,.18)'
    }
    const [head, ...tail] = label.split('｜')
    document.getElementById('cap').innerHTML = label ? (tail.length ? `<em>${head}</em>${tail.join('｜')}` : head) : ''
  }, [html, p, CW, LH, caption(f.t)])
  const file = path.join(outDir, 'frames', String(n++).padStart(5, '0') + '.png')
  await page.screenshot({ path: file })
  const next = k + 1 < cap.frames.length ? cap.frames[k + 1].t : cap.end + 1500
  list.push(`file '${path.resolve(file)}'\nduration ${Math.max(0.02, (next - f.t) / 1000).toFixed(3)}`)
}
await browser.close()
list.push(`file '${path.resolve(path.join(outDir, 'frames', String(n - 1).padStart(5, '0') + '.png'))}'`)
fs.writeFileSync(path.join(outDir, 'list.txt'), list.join('\n') + '\n')
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' })
const evenW = W - (W % 2), evenH = H - (H % 2)
ff('-f', 'concat', '-safe', '0', '-i', path.join(outDir, 'list.txt'), '-vf', `fps=24,crop=${evenW}:${evenH}:0:0`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'slow', '-movflags', '+faststart', path.join(outDir, 'demo.mp4'))
ff('-i', path.join(outDir, 'demo.mp4'), '-vf', `fps=10,scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, path.join(outDir, 'demo.gif'))
console.log(`${n} frames → ${outDir}/demo.mp4, demo.gif (${W}x${H})`)
