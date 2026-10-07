#!/usr/bin/env node
// Creates a tag and GitHub Release for every console-status version on main that has none yet.
// Each version is tagged at the first-parent commit that set it in plugin.json; its notes are the
// CHANGELOG.md sections since the previous released version (versions that never reached main ride
// along with the next one). Only the current version is marked latest. Safe to re-run.
// Usage: node scripts/release.mjs [--dry-run]   (needs git history and, without --dry-run, gh with GH_TOKEN)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = 'plugins/console-status/.claude-plugin/plugin.json'
const dryRun = process.argv.includes('--dry-run')
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })
const git = (...args) => run('git', args).trim()

const compare = (a, b) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

// Oldest first: the commit that introduced each version on main.
const introduced = new Map()
for (const sha of git('log', '--first-parent', '--reverse', '--format=%H', 'HEAD', '--', manifest).split('\n').filter(Boolean)) {
  const { version } = JSON.parse(git('show', `${sha}:${manifest}`))
  if (!introduced.has(version)) introduced.set(version, sha)
}
const versions = [...introduced.keys()].sort(compare)
const current = JSON.parse(readFileSync(join(root, manifest), 'utf8')).version

const sections = new Map()
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
for (const [, version, body] of changelog.matchAll(/^## (\d+\.\d+\.\d+)\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm))
  sections.set(version, body.trim())

const notesFor = (version, previous) => {
  const included = [...sections.keys()]
    .filter(v => compare(v, version) <= 0 && (!previous || compare(v, previous) > 0))
    .sort(compare).reverse()
  if (!included.length) return `console-status ${version}.`
  if (included.length === 1) return sections.get(version) ?? sections.get(included[0])
  return included.map(v => `### ${v}\n\n${sections.get(v)}`).join('\n\n')
}

const exists = args => {
  try { run('gh', args, { stdio: 'ignore' }); return true } catch { return false }
}

let created = 0
versions.forEach((version, i) => {
  const tag = `v${version}`
  const sha = introduced.get(version)
  const notes = notesFor(version, versions[i - 1])
  if (dryRun) {
    console.log(`── ${tag} @ ${sha.slice(0, 7)}${version === current ? ' (latest)' : ''}\n${notes}\n`)
    return
  }
  if (exists(['release', 'view', tag])) return
  run('gh', ['release', 'create', tag, '--target', sha, '--title', `console-status ${version}`,
    '--notes-file', '-', `--latest=${version === current}`], { input: notes, stdio: ['pipe', 'inherit', 'inherit'] })
  created++
})
if (!dryRun) console.log(created ? `✓ created ${created} release(s)` : `✓ releases up to date (console-status ${current})`)
