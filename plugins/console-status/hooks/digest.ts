/**
 * The executor digest: what a project's latest executor session was last doing, in four lines,
 * for the project card and for the context a prompt about that project carries.
 * Pure parts first; `loadDigest` is the one that touches files, through the `DigestIo` it is given.
 */

/** How much of a transcript's end is parsed. */
export const TAIL_CHARS = 65_536
/** `$.fs.read` refuses files past 4 MiB; a larger transcript's tail is read by a small process instead. */
export const READ_LIMIT = 4 * 1024 * 1024
export const DIGEST_NONE = '執行者摘要：無紀錄'
/** How long a prompt waits for a digest; past it, the project's last digest goes with it, or this note. */
export const PROMPT_DIGEST_MS = 2000
export const DIGEST_TIMEOUT = '執行者摘要：無法讀取（逾時）'

export type DigestJob = { id?: string; launchName?: string; kind?: string; status?: string; phase?: string; sessionId?: string; nativeId?: string }
export type DaemonRecord = { sessionId?: string; linkScanPath?: string; state?: string; detail?: string }
export type ParsedTail = { lastAt: string | null; tools: string[]; lastText: string }
export type DigestResult = { kind: 'none' } | { kind: 'ready'; lines: string[] } | { kind: 'error'; error: string }
export type DigestIo = {
  windows: boolean
  read(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{ size: number; mtimeMs: number }>
  list(path: string): Promise<{ name: string; kind: string }[]>
  run(argv: string[], init?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string }>
}
/** Transcript path → the parse of its tail, kept while its mtime and size stay the same. */
export type DigestCache = Map<string, { key: string; parsed: ParsedTail }>

const rootKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The newest job the plugin recorded for a project root, and the root's own session as a fallback. */
export function latestJob(state: unknown, root: string): { job: DigestJob | null; rootSessionId?: string } {
  const roots = (state as { roots?: Record<string, { sessionId?: string; jobs?: DigestJob[] }> } | null)?.roots
  const entry = roots?.[rootKey(root)]
  if (!entry) return { job: null }
  const jobs = Array.isArray(entry.jobs) ? entry.jobs : []
  return { job: jobs[jobs.length - 1] ?? null, ...(entry.sessionId ? { rootSessionId: entry.sessionId } : {}) }
}

/**
 * The session the job really ran in: the daemon's record first (a resume copy runs in a session
 * the plugin did not record), then the plugin's job, then the project's last session.
 */
export function pickSession(job: DigestJob | null, daemon: DaemonRecord | null, rootSessionId: string | undefined): { sessionId: string | null; transcript?: string } {
  if (daemon?.sessionId) return { sessionId: daemon.sessionId, ...(daemon.linkScanPath ? { transcript: daemon.linkScanPath } : {}) }
  return { sessionId: job?.sessionId || rootSessionId || null }
}

/** The last `limit` characters of a transcript, from the first whole line inside them. */
export function tailWindow(text: string, limit = TAIL_CHARS): string {
  if (text.length <= limit) return text
  const cut = text.slice(-limit)
  const start = cut.indexOf('\n')
  return start < 0 ? '' : cut.slice(start + 1)
}

/** Last timestamp, last three tool calls (`Name: argument`) and last assistant text of a transcript. */
export function parseTranscript(text: string): ParsedTail {
  let lastAt: string | null = null
  const tools: string[] = []
  let lastText = ''
  for (const row of text.split('\n')) {
    if (!row.trim()) continue
    let entry: any
    try { entry = JSON.parse(row) } catch { continue }
    if (typeof entry?.timestamp === 'string') lastAt = entry.timestamp
    if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue
    for (const block of entry.message.content) {
      if (block?.type === 'tool_use') {
        const input = block.input ?? {}
        const arg = oneLine(String(input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? '')).slice(0, 80)
        tools.push(arg ? `${block.name}: ${arg}` : String(block.name))
      } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) lastText = block.text
    }
  }
  return { lastAt, tools: tools.slice(-3), lastText }
}

/** The four lines, always four: executor, last activity, last actions, last words. */
export function digestLines(job: DigestJob | null, daemon: DaemonRecord | null, parsed: ParsedTail, now: number): string[] {
  const name = job?.launchName || job?.id || '-'
  const at = parsed.lastAt ? Date.parse(parsed.lastAt) : NaN
  const minutes = Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : null
  const words = oneLine(parsed.lastText)
  return [
    `執行者：${name} · ${job?.kind || '-'} · ${job?.status || '?'}/${daemon?.state || job?.phase || '?'}`,
    parsed.lastAt ? `最後活動：${parsed.lastAt} （${minutes ?? '?'} 分鐘前）` : '最後活動：無',
    parsed.tools.length ? `最後動作：${parsed.tools.join(' → ')}` : '最後動作：無',
    words ? `最後一句：${words.length > 400 ? `…${words.slice(-399)}` : words}` : '最後一句：無',
  ]
}

/** The block a prompt carries: the four lines, or `執行者摘要：無紀錄`. */
export function digestContext(lines: string[] | null): string {
  return lines ? `執行者摘要：\n${lines.join('\n')}` : DIGEST_NONE
}

/** Reads the last bytes of a file too large for `$.fs.read`. */
export function tailArgs(path: string, windows: boolean, bytes = TAIL_CHARS): string[] {
  if (!windows) return ['tail', '-c', String(bytes), path]
  const quoted = path.replace(/'/g, "''")
  return ['powershell', '-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $f=[IO.File]::Open('${quoted}','Open','Read','ReadWrite'); try { $n=[Math]::Min($f.Length,${bytes}); [void]$f.Seek(-$n,'End'); $b=New-Object byte[] $n; [void]$f.Read($b,0,$n); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b)) } finally { $f.Close() }`]
}

async function readJson(io: DigestIo, path: string): Promise<any> {
  try { return JSON.parse(await io.read(path)) } catch { return null }
}

/** Where a session's transcript is: `<claudeDir>/projects/<any>/<sessionId>.jsonl`, remembered per session. */
async function findTranscript(io: DigestIo, claudeDir: string, sessionId: string, paths: Map<string, string>): Promise<string | null> {
  const known = paths.get(sessionId)
  if (known && await io.exists(known).catch(() => false)) return known
  const dirs = await io.list(`${claudeDir}/projects`).catch(() => [])
  for (const dir of dirs) {
    if (dir.kind !== 'dir') continue
    const candidate = `${claudeDir}/projects/${dir.name}/${sessionId}.jsonl`
    if (await io.exists(candidate).catch(() => false)) { paths.set(sessionId, candidate); return candidate }
  }
  return null
}

/**
 * The digest of a project's latest executor session. A transcript is read again only when its
 * mtime or size changed; nothing found is `none`; a read that fails is `error`, never a throw.
 */
export async function loadDigest(io: DigestIo, where: { root: string; claudeDir: string; sessionsPath: string }, cache: DigestCache, paths: Map<string, string>, now: number): Promise<DigestResult> {
  try {
    const { job, rootSessionId } = latestJob(await readJson(io, where.sessionsPath), where.root)
    if (!job && !rootSessionId) return { kind: 'none' }
    const daemon: DaemonRecord | null = job?.nativeId ? await readJson(io, `${where.claudeDir}/jobs/${job.nativeId}/state.json`) : null
    const { sessionId, transcript } = pickSession(job, daemon, rootSessionId)
    let path = transcript && await io.exists(transcript).catch(() => false) ? transcript : null
    if (!path && sessionId) path = await findTranscript(io, where.claudeDir, sessionId, paths)
    if (!path) return { kind: 'none' }
    const stat = await io.stat(path)
    const key = `${stat.mtimeMs}:${stat.size}`
    let parsed = cache.get(path)?.key === key ? cache.get(path)!.parsed : null
    if (!parsed) {
      let text: string
      if (stat.size <= READ_LIMIT) text = await io.read(path)
      else {
        const result = await io.run(tailArgs(path, io.windows), { timeoutMs: 15_000 })
        if (result.exitCode !== 0) throw new Error(`讀取 transcript 尾端失敗（exit ${result.exitCode}）`)
        text = result.stdout
      }
      parsed = parseTranscript(tailWindow(text))
      cache.set(path, { key, parsed })
    }
    return { kind: 'ready', lines: digestLines(job, daemon, parsed, now) }
  } catch (error) {
    return { kind: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
