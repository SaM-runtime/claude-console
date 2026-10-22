#!/usr/bin/env node
// Checks that a console-status dispatch prompt reaches a `claude --bg` session whole, on this machine.
// On Windows `claude` is often npm's claude.cmd, which runs through cmd.exe: an argument there ends at its
// first line break and splits at `&`, so console-status hands the prompt over on standard input instead.
// Starts sessions through the engine's own $.process.run (scripts/dispatch-probe) with a throwaway home and
// an API address nothing listens on, so no request leaves the machine.
// Usage: node scripts/check-dispatch.mjs [--report]   (--report: print what arrived, never fail)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const windows = process.platform === 'win32'
const reportOnly = process.argv.includes('--report')
const home = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-check-')))
const work = join(home, 'project')
const bin = join(home, 'bin')
mkdirSync(work)
mkdirSync(bin)

// Shaped like a dispatch prompt (several lines, Chinese), plus every character cmd.exe gives a meaning.
const PROMPT = [
  '依 STATUS CARD 的下一步繼續；結束時更新 CARD（含關卡欄）',
  'STATUS：D:/專案 A/STATUS.md',
  'say "A & B" | 100% ^x^ <y> (z) !v! %PATH% `q` ; , = \\"end\\"',
].join('\n')

// A stand-in claude that prints what it got, behind a cmd shim shaped like npm's (on Windows) or a sh one.
writeFileSync(join(bin, 'echo.js'), "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:s})))\n")
const fake = join(bin, windows ? 'claude.cmd' : 'claude')
writeFileSync(fake, windows
  ? `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"${process.execPath}" "%dp0%\\echo.js"   %*\r\n`
  : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/echo.js" "$@"\n`, { mode: 0o755 })

// `claude --bg` starts only in a folder trusted before; the throwaway config trusts the project folder.
const trusted = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
writeFileSync(join(home, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  projects: Object.fromEntries([...new Set([work, work.replace(/\\/g, '/')])].map(key => [key, trusted])),
}))

const env = { ...process.env, HOME: home, USERPROFILE: home, ANTHROPIC_API_KEY: 'sk-ant-dispatch-check', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }
for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) delete env[name]

const quote = arg => (windows && /[\s"&|<>^%]/.test(arg) ? `"${arg}"` : arg)
const claude = (args, timeout = 120_000) => {
  const result = spawnSync('claude', windows ? args.map(quote) : args, { cwd: work, env, encoding: 'utf8', timeout, shell: windows })
  return { code: result.status, out: result.stdout ?? '', err: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}` }
}

const plan = [
  { name: 'shim, prompt as argument', argv: [fake, '--bg', '--name', 'x', PROMPT], cwd: work },
  { name: 'shim, prompt on stdin', argv: [fake, '--bg', '--name', 'x'], stdin: PROMPT, cwd: work },
  { name: 'which claude', argv: windows ? ['where', 'claude'] : ['sh', '-c', 'command -v claude'], cwd: work },
  { name: 'claude --bg, prompt as argument', argv: ['claude', '--bg', '--name', 'check-argv', PROMPT], cwd: work },
  { name: 'claude --bg, prompt on stdin', argv: ['claude', '--bg', '--name', 'check-stdin'], stdin: PROMPT, cwd: work },
]
env.DISPATCH_PROBE_PLAN = JSON.stringify(plan)
const probe = claude(['-p', '/dispatch-probe', '--plugin-dir', join(root, 'scripts', 'dispatch-probe')])
// The engine prints a command's text after the plugin's name (`dispatch-probe: DISPATCH_PROBE {...}`).
const line = probe.out.split(/\r?\n/).find(text => text.includes('DISPATCH_PROBE {'))
if (!line) {
  console.error(`✕ the probe plugin did not answer (exit ${probe.code})\n${probe.out}\n${probe.err}`)
  process.exit(1)
}
const results = JSON.parse(line.slice(line.indexOf('DISPATCH_PROBE {') + 'DISPATCH_PROBE '.length))

/** The first prompt a background session recorded, read from its transcript. */
function firstPrompt(name) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const listed = claude(['agents', '--json', '--all'], 60_000)
    let agents = []
    try { agents = JSON.parse(listed.out) } catch { /* the daemon may still be starting */ }
    const agent = (Array.isArray(agents) ? agents : agents.agents ?? []).find(a => a.name === name)
    const projects = join(home, '.claude', 'projects')
    if (agent?.sessionId && existsSync(projects)) {
      for (const dir of readdirSync(projects)) {
        const file = join(projects, dir, `${agent.sessionId}.jsonl`)
        if (!existsSync(file)) continue
        for (const row of readFileSync(file, 'utf8').split('\n')) {
          let entry
          try { entry = JSON.parse(row) } catch { continue }
          if (entry?.type !== 'user' || entry.isMeta) continue
          const content = entry.message?.content
          const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text).join('\n') : ''
          if (text) return { id: agent.id, text }
        }
      }
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)'])
  }
  return null
}

const rows = []
const verdict = (name, got) => {
  rows.push({ name, ok: got === PROMPT, got })
}
for (const name of ['shim, prompt as argument', 'shim, prompt on stdin']) {
  const result = results[name]
  let echoed = null
  try { echoed = JSON.parse(result.stdout) } catch { /* reported below */ }
  verdict(name, echoed ? (name.endsWith('argument') ? echoed.argv.at(-1) : echoed.stdin) ?? '' : JSON.stringify(result))
}
const sessions = []
for (const [name, label] of [['check-argv', 'claude --bg, prompt as argument'], ['check-stdin', 'claude --bg, prompt on stdin']]) {
  const launched = results[label]
  const found = launched && !launched.error && launched.exitCode === 0 ? firstPrompt(name) : null
  if (found) sessions.push(found.id)
  verdict(label, found ? found.text : `not started: ${JSON.stringify(launched)}`)
}
for (const id of sessions) {
  claude(['stop', id], 60_000)
  claude(['rm', id], 60_000)
}

console.log(`claude on PATH: ${(results['which claude']?.stdout ?? '').trim().split(/\r?\n/).join(' | ')}`)
for (const row of rows) console.log(`${row.ok ? '✓' : '✕'} ${row.name}${row.ok ? '' : `: got ${JSON.stringify(row.got)}`}`)
const needed = rows.find(row => row.name === 'claude --bg, prompt on stdin')
if (!reportOnly && !needed?.ok) process.exit(1)
