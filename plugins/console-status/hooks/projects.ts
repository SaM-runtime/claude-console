// /console add, archive and unarchive: the registry's text, rewritten. Pure text work; register.tsx reads and writes the files.
import { STATUS_TEMPLATE } from './template'
import { parseRegistry } from './logic'
import type { RegistryRow } from './logic'

/** The folder /console add names: the words after it (quotes dropped), else the session's own; slashes forward, no trailing one. */
export function addFolder(words: string, cwd: string | null): string | null {
  const raw = words.trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim() || (cwd ?? '').trim()
  const folder = raw.replace(/\\/g, '/').replace(/(?<=.)\/+$/, '')
  return folder || null
}

/** A new project's name: its folder's name (a `|` would split the registry row), numbered when another project has it. */
export function projectNameFor(folder: string, taken: string[]): string {
  const base = (folder.split('/').filter(Boolean).pop() ?? folder).replace(/\|/g, '-')
  const used = new Set(taken.map(name => name.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  let n = 2
  while (used.has(`${base} ${n}`.toLowerCase())) n++
  return `${base} ${n}`
}

const TABLE = ['| Project | STATUS path |', '| --- | --- |']

/**
 * The registry text with the new project's row: last in the `STATUS 卡位置` table, with as many cells as its
 * header has (an `Executor` column left blank, which is the global default). A file or section without that
 * table gets one. Line endings stay as the file has them.
 */
export function registryWith(text: string | null, name: string, statusPath: string): string {
  const crlf = /\r\n/.test(text ?? '')
  const lines = (text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  const row = (columns: number) => `| ${name} | \`${statusPath}\` |${'  |'.repeat(Math.max(0, columns - 2))}`
  const heading = lines.findIndex(line => line.trim() === '## STATUS 卡位置')
  if (!lines.join('').trim()) lines.splice(0, lines.length, '# Project registry', '', '## STATUS 卡位置', '', ...TABLE, row(2))
  else if (heading < 0) lines.push('', '## STATUS 卡位置', '', ...TABLE, row(2))
  else {
    const after = lines.findIndex((line, i) => i > heading && /^## /.test(line))
    const end = after < 0 ? lines.length : after
    const table = lines.map((line, i) => ({ line, i })).filter(({ line, i }) => i > heading && i < end && /^\s*\|/.test(line))
    if (!table.length) lines.splice(heading + 1, 0, '', ...TABLE, row(2))
    else {
      const columns = table[0]!.line.trim().replace(/^\||\|$/g, '').split('|').length
      lines.splice(table[table.length - 1]!.i + 1, 0, row(columns))
    }
  }
  const out = lines.join('\n') + '\n'
  return crlf ? out.replace(/\n/g, '\r\n') : out
}

/** Where archived projects' rows go: a section of their own in the registry, which the console does not refresh. */
export const ARCHIVE_SECTION = '已封存'

type Lines = { lines: string[]; crlf: boolean }
const toLines = (text: string): Lines => ({ crlf: /\r\n/.test(text), lines: text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n') })
const fromLines = ({ lines, crlf }: Lines): string => { const out = lines.join('\n') + '\n'; return crlf ? out.replace(/\n/g, '\r\n') : out }

/** The `## <title>` section: its heading line and the line after its last (the next `## ` heading, or the end). */
function section(lines: string[], title: string): { heading: number; end: number } | null {
  const heading = lines.findIndex(line => line.trim() === `## ${title}`)
  if (heading < 0) return null
  const after = lines.findIndex((line, i) => i > heading && /^## /.test(line))
  return { heading, end: after < 0 ? lines.length : after }
}
const tableAt = (lines: string[], range: { heading: number; end: number }) =>
  lines.map((line, i) => ({ line, i })).filter(({ line, i }) => i > range.heading && i < range.end && /^\s*\|/.test(line)).map(({ i }) => i)
/** A project row's name (its first cell, as the registry reads it); null for a header, a separator or other text. */
const rowName = (line: string): string | null => line.match(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`/)?.[1] ?? null
const rowPath = (line: string): string | null => line.match(/^\|\s*[^|]+?\s*\|\s*`([^`]+)`/)?.[1] ?? null

/** `row` last in the `title` table, under `head` (the header and separator lines) when the section has no table yet. */
function insertRow(lines: string[], title: string, row: string, head: string[]) {
  const range = section(lines, title)
  if (!range) {
    lines.push('', `## ${title}`, '', ...head, row)
    return
  }
  const table = tableAt(lines, range)
  if (table.length) lines.splice(table[table.length - 1]! + 1, 0, row)
  else lines.splice(range.heading + 1, 0, '', ...head, row)
}

/** The header and separator of the `title` table, for a table made beside it; the plain two columns without one. */
function headOf(lines: string[], title: string): string[] {
  const range = section(lines, title)
  const head = range ? tableAt(lines, range).filter(i => rowName(lines[i]!) === null).slice(0, 2).map(i => lines[i]!) : []
  return head.length === 2 ? head : TABLE
}

/** A row's STATUS path as the console reads it (`~` expanded, slashes forward), compared without case. */
const samePath = (raw: string | null, statusPath: string, home: string) =>
  raw !== null && raw.replace(/^~/, home).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === statusPath.replace(/\/+$/, '').toLowerCase()

/**
 * The registry with the project `name` moved from the `STATUS 卡位置` table to the `## 已封存` section (made at the
 * end of the file, with the same header, when missing). Its `statusPath`, when given, finds the row first: the pane
 * numbers a name the registry uses twice (`api 2`). Null when the table has no such project.
 */
export function registryArchive(text: string, name: string, statusPath?: string, home = ''): string | null {
  const file = toLines(text)
  const main = section(file.lines, 'STATUS 卡位置')
  const rows = main ? tableAt(file.lines, main) : []
  const at = (statusPath ? rows.find(i => samePath(rowPath(file.lines[i]!), statusPath, home)) : undefined) ?? rows.find(i => rowName(file.lines[i]!) === name)
  if (at === undefined) return null
  const head = headOf(file.lines, 'STATUS 卡位置')
  const [row] = file.lines.splice(at, 1)
  insertRow(file.lines, ARCHIVE_SECTION, row!, head)
  return fromLines(file)
}

/**
 * The registry with the archived project `name` back last in the `STATUS 卡位置` table; a `## 已封存` section left
 * with no project goes too. Null when the section has no such project.
 */
export function registryUnarchive(text: string, name: string): string | null {
  const file = toLines(text)
  const archive = section(file.lines, ARCHIVE_SECTION)
  const at = archive ? tableAt(file.lines, archive).find(i => rowName(file.lines[i]!) === name) : undefined
  if (archive === null || at === undefined) return null
  const head = headOf(file.lines, ARCHIVE_SECTION)
  const [row] = file.lines.splice(at, 1)
  const left = section(file.lines, ARCHIVE_SECTION)!
  const body = file.lines.slice(left.heading + 1, left.end)
  // Nothing but its own table header and blank lines: the section was the console's, and goes with its last row.
  if (body.every(line => !line.trim() || (/^\s*\|/.test(line) && rowName(line) === null))) {
    const from = left.heading > 0 && !file.lines[left.heading - 1]!.trim() ? left.heading - 1 : left.heading
    file.lines.splice(from, left.end - from)
  }
  // A project registered again meanwhile keeps its row; the archived copy only goes.
  const main = section(file.lines, 'STATUS 卡位置')
  const listed = main ? tableAt(file.lines, main).some(i => rowPath(file.lines[i]!) === rowPath(row!)) : false
  if (!listed) {
    if (main) insertRow(file.lines, 'STATUS 卡位置', row!, head)
    else file.lines.push('', '## STATUS 卡位置', '', ...head, row!)
  }
  return fromLines(file)
}

/** The archived projects: the `## 已封存` section's rows, read as the registry's own. */
export function archivedRows(text: string, home: string): RegistryRow[] {
  const { lines } = toLines(text)
  const range = section(lines, ARCHIVE_SECTION)
  return range ? parseRegistry(['## STATUS 卡位置', ...lines.slice(range.heading + 1, range.end)].join('\n'), home) : []
}

/** The STATUS file a new project starts with: the workflow's template, its name in the title, a CARD that says it was just added. */
export function newStatusFile(name: string, stamp: string): string {
  return STATUS_TEMPLATE
    .replace('# <Project name> STATUS', `# ${name} STATUS`)
    .replace(/^- 更新：.*$/m, `- 更新：${stamp} · rev 1 · /console add`)
    .replace(/^- 狀態：.*$/m, '- 狀態：剛加入主控台，還沒有工作紀錄')
    .replace(/^- 驗證：.*$/m, '- 驗證：')
    .replace(/^- 執行中：.*$/m, '- 執行中：無')
    .replace(/^- 等使用者：.*$/m, '- 等使用者：無')
    .replace(/^- 下一步：.*$/m, '- 下一步：無')
}

/** `.git/info/exclude` with `.console/` added so the STATUS file stays out of commits; null when it already is. */
export function excludeWith(text: string | null): string | null {
  const body = text ?? ''
  if (body.split(/\r?\n/).some(line => /^\/?\.console(?:\/|\/\*\*?)?$/.test(line.trim()))) return null
  return `${body}${body && !body.endsWith('\n') ? '\n' : ''}.console/\n`
}

/** A local `YYYY-MM-DD HH:MM`, as a CARD's 更新 is written. */
export function localMinute(time: number): string {
  const d = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
