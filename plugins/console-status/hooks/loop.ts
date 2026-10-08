// Loop guard: a tool call that fails twice in a row with the same arguments and the same error gets a note
// telling the model not to try a third time. Pure: no I/O. The rule follows loop-guard in
// arasovic/claude-code-mods (MIT); this is console-status's own implementation.

export type LoopMode = 'on' | 'off'
export const loopMode = (value: unknown): LoopMode => String(value ?? '').trim().toLowerCase() === 'off' ? 'off' : 'on'

/** Keys of `tool.call`'s input that are not the call's arguments, or that change without changing the call. */
const IGNORED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'description'])

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as any)[k])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** One call's identity: its tool, its loop (main or a subagent) and its arguments. */
export function loopKey(e: Record<string, unknown>): string {
  const args: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) if (!IGNORED.has(k)) args[k] = v
  return `${String(e.tool)}|${String(e.agentId ?? 'main')}|${stable(args)}`
}

/** An error that names a time, a date or a random id differs every run, so it is never matched. */
const VOLATILE = /\b\d{1,2}:\d{2}:\d{2}\b|\b\d{4}-\d{2}-\d{2}T\d|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|\b[0-9a-f]{24,}\b/i

export const LOOP_NOTE = '[console-status 重複失敗護欄] 這個呼叫用完全相同的參數已經第二次失敗，而且錯誤訊息一樣。不要第三次照原樣重試：重讀錯誤訊息、換一個做法，或請使用者協助。'

/** Failed calls by key: the last error and whether its pair was already flagged. A success forgets the call. */
export class LoopMemory {
  private calls = new Map<string, { error: string; flagged: boolean }>()
  constructor(private readonly limit = 200) {}

  /** Records an outcome; true when this is the second identical failure in a row (flag it once). */
  record(key: string, error: string | null): boolean {
    if (error === null) { this.calls.delete(key); return false }
    const text = error.replace(/\s+/g, ' ').trim().slice(0, 4000)
    const prev = this.calls.get(key)
    const repeat = !!prev && prev.error === text && !VOLATILE.test(text)
    const flag = repeat && !prev!.flagged
    this.calls.delete(key)
    this.calls.set(key, { error: text, flagged: repeat && (prev!.flagged || flag) })
    while (this.calls.size > this.limit) this.calls.delete(this.calls.keys().next().value as string)
    return flag
  }

  clear() { this.calls.clear() }
}
