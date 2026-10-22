// /console add: a folder becomes a registered project. Pure text work; register.tsx reads and writes the files.
import { STATUS_TEMPLATE } from './template'

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
