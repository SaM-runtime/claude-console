#!/usr/bin/env node
// Runs the outside commands console-status builds, on this operating system, through Claude Code's own process
// runner, and checks what comes back: the Codex probe scripts (PowerShell on Windows, sh elsewhere) against a
// made-up Codex folder, a CARD's 驗證 command, the transcript tails, and a Claude dispatch whose prompt must
// reach the background session whole (on Windows through npm's claude.cmd, where cmd.exe cuts an argument at
// its first line break). Uses a throwaway home and an API address nothing listens on: no request leaves.
// Usage: node scripts/check-commands.mjs   (needs `claude` on PATH)
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const windows = process.platform === 'win32'
// The long form of the path: Windows' TEMP can be 8.3 (`RUNNER~1`), which background sessions report spelled out.
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'console-commands-')))
const dir = (...parts) => { const path = join(home, ...parts); mkdirSync(path, { recursive: true }); return path }
const work = dir('project')
const problems = []
const notes = []
const check = (ok, text) => { if (!ok) problems.push(text) }

// The plugin under test: this probe beside a copy of console-status's hooks (a plugin imports only from its own folder).
const plugin = dir('plugin')
cpSync(join(root, 'plugins/console-status/hooks'), join(plugin, 'console/hooks'), { recursive: true })
cpSync(join(root, 'plugins/console-status/types'), join(plugin, 'console/types'), { recursive: true })
mkdirSync(join(plugin, 'hooks'))
cpSync(join(root, 'scripts/command-probe/register.ts'), join(plugin, 'hooks/register.ts'))
mkdirSync(join(plugin, '.claude-plugin'))
writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'command-probe', version: '0.0.0', description: 'CI only' }))
writeFileSync(join(plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))

// A Codex sessions folder: the newest rollout's last rate_limits line is the reading; an older file must lose.
const now = Date.now()
const resets = Math.floor(now / 1000) + 3600
const stamp = new Date(now - 60_000).toISOString()
const event = (at, primary, secondary) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: { primary: { used_percent: primary, window_minutes: 300, resets_at: resets }, secondary: { used_percent: secondary, window_minutes: 10080, resets_at: resets + 86400 } } } })
const today = new Date()
const pad = n => String(n).padStart(2, '0')
const month = dir('.codex', 'sessions', String(today.getFullYear()), pad(today.getMonth() + 1), pad(today.getDate()))
writeFileSync(join(month, 'rollout-new.jsonl'), [
  JSON.stringify({ timestamp: stamp, type: 'session_meta', payload: { cwd: 'D:/專案' } }),
  event(new Date(now - 120_000).toISOString(), 30, 5),
  JSON.stringify({ timestamp: stamp, type: 'response_item', payload: { type: 'message', content: [{ text: '改好了，"rate_limits" 只是字串' }] } }),
  event(stamp, 42, 7),
  JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'agent_message', message: '完成' } }),
].join('\n') + '\n')
const old = join(dir('.codex', 'sessions', '2020', '01', '01'), 'rollout-old.jsonl')
writeFileSync(old, event('2020-01-01T00:00:00.000Z', 99, 99) + '\n')
utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'))

// The companion: a script that exists, and state roots (the Temp one and the plugin-data one).
const companion = join(dir('codex-plugin'), 'codex-companion.mjs')
writeFileSync(companion, '// stand-in\n')
const stateDir = dir('Temp', 'codex-companion')
const stateRoots = [dir('.claude', 'plugins', 'data', 'codex-openai-codex', 'state'), stateDir]

// A transcript with Chinese in it (Big5's troublesome 許功蓋 included) and long lines, longer than both tails.
const tailFile = join(home, 'transcript.jsonl')
const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ n: i, text: `第 ${i} 行：許功蓋 ✓ "引號" \\ 反斜線`, pad: 'x'.repeat(300) }))
writeFileSync(tailFile, lines.join('\n') + '\n')

// A stand-in claude behind a shim like npm's (cmd on Windows), printing the arguments and input it got.
const bin = dir('bin')
writeFileSync(join(bin, 'echo.js'), "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:s})))\n")
const shim = join(bin, windows ? 'claude.cmd' : 'claude')
writeFileSync(shim, windows
  ? `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"${process.execPath}" "%dp0%\\echo.js"   %*\r\n`
  : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/echo.js" "$@"\n`, { mode: 0o755 })

// Shaped like a dispatch prompt (lines, Chinese, a path), plus every character cmd.exe gives a meaning.
const prompt = [
  '依 STATUS CARD 的下一步繼續；遵守任務骨架；結束時更新 CARD（含關卡欄）',
  'STATUS：D:/專案 A/STATUS.md',
  '使用者回覆："A & B" | 100% ^x^ <y> (z) !v! %PATH% ; = \\"end\\"',
  '這次工作的代號是 c-1a2b3c。',
].join('\n')

const verify = windows
  ? { verifyPass: "Write-Output '驗證通過 ✓'", verifyNative: `node -e "console.log('原生程式輸出：測試通過')"`, verifyFail: `node -e "process.exit(3)"` }
  : { verifyPass: "echo '驗證通過 ✓'", verifyNative: `node -e "console.log('原生程式輸出：測試通過')"`, verifyFail: `node -e "process.exit(3)"` }

// `claude --bg` starts only in a folder trusted before.
const trusted = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
writeFileSync(join(home, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  projects: Object.fromEntries([...new Set([work, work.replace(/\\/g, '/')])].map(key => [key, trusted])),
}))

const env = { ...process.env, HOME: home, USERPROFILE: home, ANTHROPIC_API_KEY: 'sk-ant-console-commands', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }
for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) delete env[name]
env.COMMAND_PROBE = JSON.stringify({
  pluginRoot: join(root, 'plugins', 'console-status'), work, sessions: join(dir('.claude', 'handoffs'), 'claude-sessions.json'),
  companion, stateDir, stateRoots, tailFile, shim, prompt, verify,
})
const claude = (args, timeout = 180_000) => {
  const result = spawnSync('claude', windows ? args.map(arg => (/[\s&|<>^"]/.test(arg) ? `"${arg}"` : arg)) : args, { cwd: work, env, encoding: 'utf8', timeout, shell: windows })
  return { code: result.status, out: result.stdout ?? '', err: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}` }
}

const probe = claude(['-p', '/command-probe', '--plugin-dir', plugin])
const line = probe.out.split(/\r?\n/).find(text => text.includes('COMMAND_PROBE {'))
if (!line) {
  console.error(`✕ the probe plugin did not answer (exit ${probe.code})\n${probe.out}\n${probe.err}`)
  process.exit(1)
}
const r = JSON.parse(line.slice(line.indexOf('COMMAND_PROBE {') + 'COMMAND_PROBE '.length))
const said = step => step?.error ? `error: ${step.error}` : `exit ${step?.exitCode}: ${JSON.stringify(`${step?.stdout ?? ''}${step?.stderr ?? ''}`.slice(0, 300))}`
const text = value => String(value ?? '').replace(/\r\n/g, '\n')

// Codex probes.
const quota = r.quotaParsed
check(quota && quota.at === stamp && JSON.stringify(quota.limits.map(l => [l.label, l.percent])) === JSON.stringify([['Codex 5 小時', 42], ['Codex 週', 7]]),
  `Codex quota probe: expected 42% / 7% read at ${stamp}, got ${JSON.stringify(quota)} (${said(r.quota)})`)
check(/^(OK|STALE|UNKNOWN) codex=\S+ companion=OK\b/.test(text(r.preflight?.stdout).trim().split('\n').pop()), `Codex preflight: ${said(r.preflight)}`)
check(/ companion=MISSING\b/.test(text(r.preflightMissing?.stdout)), `Codex preflight with a missing companion: ${said(r.preflightMissing)}`)

// Verification.
check(r.verifyPassResult?.ok && r.verifyPassResult.lines.includes('驗證通過 ✓'), `a passing 驗證 command: ${JSON.stringify(r.verifyPassResult)} (${said(r.verifyPass)})`)
check(r.verifyNativeResult?.ok && r.verifyNativeResult.lines.includes('原生程式輸出：測試通過'), `a 驗證 command's program output: ${JSON.stringify(r.verifyNativeResult)} (${said(r.verifyNative)})`)
check(r.verifyFailResult && !r.verifyFailResult.ok && r.verifyFailResult.exitCode === 3, `a failing 驗證 command: ${JSON.stringify(r.verifyFailResult)} (${said(r.verifyFail)})`)

// Tails.
const last = count => lines.slice(-count).join('\n')
check(r.tailBytes?.exitCode === 0 && text(r.tailBytes.stdout).trimEnd().endsWith(last(5)), `the transcript tail in bytes: ${said(r.tailBytes)}`)
check(r.tailLines?.exitCode === 0 && text(r.tailLines.stdout).trimEnd() === last(400), `the transcript tail in lines: ${said(r.tailLines)}`)

/** The first prompt a background session recorded, read from its transcript. */
function firstPrompt(sessionId) {
  const projects = join(home, '.claude', 'projects')
  for (let tries = 0; tries < 30; tries++) {
    for (const folder of existsSync(projects) ? readdirSync(projects) : []) {
      const file = join(projects, folder, `${sessionId}.jsonl`)
      if (!existsSync(file)) continue
      for (const row of readFileSync(file, 'utf8').split('\n')) {
        let entry
        try { entry = JSON.parse(row) } catch { continue }
        if (entry?.type !== 'user' || entry.isMeta) continue
        const content = entry.message?.content
        const words = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text).join('\n') : ''
        if (words) return words
      }
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'])
  }
  return null
}

// The dispatch: the executor's own launch, then what the session got.
const sessions = []
const job = r.dispatch
if (!job || job.error || !job.sessionId) problems.push(`the Claude dispatch did not launch: ${JSON.stringify(job)}`)
else {
  sessions.push(job.nativeId)
  const got = firstPrompt(job.sessionId)
  check(got === prompt, `the Claude dispatch's prompt (${windows ? 'standard input' : 'argument'}) reached the session as ${JSON.stringify(got)}`)
}
if (windows) {
  const id = text(r.dispatchAsArgument?.stdout).match(/backgrounded · ([0-9a-f]{8})/)?.[1]
  let listed = []
  try { listed = id ? JSON.parse(claude(['agents', '--json', '--all']).out) : [] } catch { /* reported as not found */ }
  const agent = (Array.isArray(listed) ? listed : []).find(a => a.id === id)
  if (id) sessions.push(id)
  const got = agent?.sessionId ? firstPrompt(agent.sessionId) : null
  notes.push(`prompt as an argument (before this fix): ${got === prompt ? 'whole' : `arrived as ${JSON.stringify(got ?? said(r.dispatchAsArgument))}`}`)
}
const echoed = step => { try { return JSON.parse(step.stdout) } catch { return null } }
notes.push(`shim, prompt as an argument: ${echoed(r.shimArgument)?.argv.at(-1) === prompt ? 'whole' : `arrived as ${JSON.stringify(echoed(r.shimArgument)?.argv ?? said(r.shimArgument))}`}`)
notes.push(`shim, prompt on standard input: ${echoed(r.shimStdin)?.stdin === prompt ? 'whole' : `arrived as ${JSON.stringify(echoed(r.shimStdin)?.stdin ?? said(r.shimStdin))}`}`)
for (const id of sessions) {
  claude(['stop', id], 60_000)
  claude(['rm', id], 60_000)
}

for (const note of notes) console.log(`· ${note}`)
if (problems.length) {
  for (const problem of problems) console.error(`✕ ${problem}`)
  process.exit(1)
}
console.log(`✓ console-status commands work here (${windows ? 'Windows' : process.platform}, ${r.windows ? 'PowerShell' : 'sh'} commands, claude: ${text(spawnSync(windows ? 'where' : 'sh', windows ? ['claude'] : ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout).trim().split('\n')[0]})`)
