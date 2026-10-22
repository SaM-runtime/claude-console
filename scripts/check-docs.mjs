#!/usr/bin/env node
// Documentation consistency checks run by CI and before a release.
// Usage: node scripts/check-docs.mjs  (from the repository root or anywhere inside it)
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(join(root, path), 'utf8')
const problems = []

const plugin = JSON.parse(read('plugins/console-status/.claude-plugin/plugin.json'))
const changelog = read('CHANGELOG.md')
if (!new RegExp(`^## ${plugin.version.replace(/\./g, '\\.')}\\s*$`, 'm').test(changelog))
  problems.push(`CHANGELOG.md has no "## ${plugin.version}" section for plugin.json version ${plugin.version}`)

const readmes = ['README.md', 'README.en.md']
for (const readme of readmes) {
  const text = read(readme)
  for (const key of Object.keys(plugin.userConfig ?? {}))
    if (!text.includes(key)) problems.push(`${readme} does not document userConfig option "${key}"`)
  // Relative links and images must point at files that exist in the repository.
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^(?:[a-z]+:|#|\/)/i.test(target)) continue
    const file = decodeURIComponent(target.split('#')[0])
    if (file && !existsSync(join(root, file))) problems.push(`${readme} links to missing file "${file}"`)
  }
  if (/\.task\//.test(text)) problems.push(`${readme} refers to .task/, which is git-ignored and absent for other contributors`)
}

// /console add writes the STATUS template from a copy inside the plugin: it must stay the workflow's template.
const embedded = [...read('plugins/console-status/hooks/template.ts').matchAll(/^  ("(?:[^"\\]|\\.)*"),$/gm)].map(m => JSON.parse(m[1])).join('\n') + '\n'
if (embedded !== read('workflow/STATUS-template.md').replace(/\r\n/g, '\n'))
  problems.push('plugins/console-status/hooks/template.ts differs from workflow/STATUS-template.md; copy the template into it')

if (problems.length) {
  for (const problem of problems) console.error(`✕ ${problem}`)
  process.exit(1)
}
console.log(`✓ docs consistent (console-status ${plugin.version})`)
