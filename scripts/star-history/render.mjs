#!/usr/bin/env node
// Draws the README star chart, cropped to the repository's fastest-growing stretch.
// Usage: node scripts/star-history/render.mjs [--fetch]
//   --fetch  refresh docs/star-history/starred-at.txt from the GitHub API first (needs gh)
// Writes docs/star-history/{zh,en}-{dark,light}.svg.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dir = join(root, 'docs/star-history')
const dataFile = join(dir, 'starred-at.txt')
const REPO = 'SaM-runtime/claude-console'
const BURST_GAP_H = 3 // a burst ends at the first gap longer than this
const TZ_H = 8 // labels are in UTC+8
const HOUR = 3600e3

if (process.argv.includes('--fetch')) {
  const out = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.star+json', '--paginate',
    `repos/${REPO}/stargazers?per_page=100`, '--jq', '.[].starred_at'], { encoding: 'utf8' })
  writeFileSync(dataFile, out.trim().split('\n').sort().join('\n') + '\n')
}

const times = readFileSync(dataFile, 'utf8').trim().split('\n').map(s => Date.parse(s)).sort((a, b) => a - b)

// Fastest growth = the burst (stars no more than BURST_GAP_H apart) holding the most stars.
let best = [0, 0], start = 0
for (let i = 1; i <= times.length; i++) {
  if (i === times.length || times[i] - times[i - 1] > BURST_GAP_H * HOUR) {
    if (i - start > best[1] - best[0]) best = [start, i]
    start = i
  }
}
const [first, last] = [best[0], best[1] - 1]
const t0 = Math.floor(times[first] / HOUR) * HOUR - HOUR
const t1 = Math.ceil(times[last] / HOUR) * HOUR + HOUR
const before = first // stars that came before the burst
const gained = last - first + 1
const hours = Math.round((times[last] - times[first]) / HOUR)

const W = 800, H = 450, L = 64, R = 32, T = 92, B = 56
const pw = W - L - R, ph = H - T - B
const yStep = [5, 10, 20, 25, 50, 100, 200, 250, 500].find(n => (before + gained) / n <= 7) ?? 1000
const yMax = Math.ceil((before + gained) / yStep) * yStep
const x = t => L + ((t - t0) / (t1 - t0)) * pw
const y = n => T + ph - (n / yMax) * ph

// Cumulative curve, one point per star.
const pts = [[x(t0), y(before)]]
for (let i = first; i <= last; i++) pts.push([x(times[i]), y(i + 1)])
pts.push([x(t1), y(before + gained)])
const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
const area = `${line} L${x(t1).toFixed(1)},${y(0)} L${x(t0).toFixed(1)},${y(0)} Z`

const local = t => new Date(t + TZ_H * HOUR)
const pad = n => String(n).padStart(2, '0')
const md = t => `${local(t).getUTCMonth() + 1}/${local(t).getUTCDate()}`
const hm = t => `${pad(local(t).getUTCHours())}:00`

const ticks = []
for (let t = Math.ceil(t0 / (6 * HOUR)) * 6 * HOUR; t <= t1; t += 6 * HOUR) ticks.push(t)

const text = {
  zh: {
    title: 'Star 成長最快的時候',
    sub: `${md(times[first])} ${hm(Math.floor(times[first] / HOUR) * HOUR)} 起 ${hours} 小時內 +${gained} 顆（UTC+8）`,
    yLabel: 'GitHub Stars',
    gain: `+${gained}`,
  },
  en: {
    title: 'Fastest star growth',
    sub: `+${gained} stars in ${hours} hours from ${md(times[first])} ${hm(Math.floor(times[first] / HOUR) * HOUR)} (UTC+8)`,
    yLabel: 'GitHub Stars',
    gain: `+${gained}`,
  },
}
const themes = {
  dark: { bg: '#0d1117', fg: '#e6edf3', muted: '#8b949e', grid: '#21262d', line: '#ff6b6b' },
  light: { bg: '#ffffff', fg: '#1f2328', muted: '#656d76', grid: '#eaeef2', line: '#e5484d' },
}

const font = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif`
function svg(lang, theme) {
  const s = text[lang], c = themes[theme]
  const yTicks = []
  for (let n = 0; n <= yMax; n += yStep) yTicks.push(n)
  let dayPrev = ''
  const ex = x(times[last]), ey = y(before + gained)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${font}">
  <defs>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.line}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${c.line}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="12" fill="${c.bg}"/>
  <text x="${L}" y="40" font-size="22" font-weight="700" fill="${c.fg}">${s.title}</text>
  <text x="${L}" y="66" font-size="14" fill="${c.muted}">${s.sub}</text>
  <text x="${W - R}" y="40" font-size="13" fill="${c.muted}" text-anchor="end">${REPO}</text>
${yTicks.map(n => `  <line x1="${L}" x2="${W - R}" y1="${y(n)}" y2="${y(n)}" stroke="${c.grid}"/>
  <text x="${L - 10}" y="${y(n) + 4}" font-size="12" fill="${c.muted}" text-anchor="end">${n}</text>`).join('\n')}
${ticks.map(t => {
    const day = md(t), label = day !== dayPrev ? `${day} ${hm(t)}` : hm(t)
    dayPrev = day
    return `  <text x="${x(t).toFixed(1)}" y="${H - B + 22}" font-size="12" fill="${c.muted}" text-anchor="middle">${label}</text>`
  }).join('\n')}
  <text transform="translate(18 ${T + ph / 2}) rotate(-90)" font-size="12" fill="${c.muted}" text-anchor="middle">${s.yLabel}</text>
  <path d="${area}" fill="url(#fill)"/>
  <path d="${line}" fill="none" stroke="${c.line}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="5" fill="${c.line}"/>
  <text x="${(ex - 10).toFixed(1)}" y="${(ey - 12).toFixed(1)}" font-size="18" font-weight="700" fill="${c.line}" text-anchor="end">${s.gain} ★</text>
</svg>
`
}

for (const lang of Object.keys(text))
  for (const theme of Object.keys(themes)) writeFileSync(join(dir, `${lang}-${theme}.svg`), svg(lang, theme))
console.log(`burst: ${new Date(times[first]).toISOString()} → ${new Date(times[last]).toISOString()}, +${gained} in ${hours}h`)
