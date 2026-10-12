// Plain-Chinese wording for values that arrive as English data (job phases, job kinds, the Codex preflight line).

const PHASE: Record<string, string> = {
  running: '執行中', working: '工作中', busy: '工作中', idle: '閒置', done: '完成', completed: '完成',
  starting: '啟動中', queued: '排隊中', unknown: '狀態不明', exited: '已結束', failed: '失敗', error: '失敗',
  cancelled: '已取消', canceled: '已取消', stopped: '已取消', killed: '已取消', blocked: '等批准', waiting: '等輸入',
}

/** A job status or phase in words: `running` → 執行中, `blocked: Bash` → 等批准：Bash; anything else as it came. */
export function phaseText(phase: string): string {
  const m = phase.trim().match(/^([a-z]+)(?::\s*(.*))?$/i)
  if (!m || !PHASE[m[1].toLowerCase()]) return phase
  const word = PHASE[m[1].toLowerCase()]
  if (!m[2]) return word
  return m[1].toLowerCase() === 'idle' ? m[2] : `${word}：${m[2]}`
}

const KIND: Record<string, string> = { sync: '同步', continue: '繼續', reply: '回覆', review: '審核', gate: '審核', task: '任務' }

/** What a dispatched job was for, in words. */
export const jobKindText = (kind: string) => KIND[kind] ?? kind

/**
 * The Codex preflight line (`STALE codex=V companion=P brokers=PID(ws) ...`, `UNKNOWN codex=unavailable ...`)
 * as a sentence that says what is wrong and what to do; '' when there is nothing to say.
 */
export function codexNote(line: string): string {
  const text = line.trim()
  if (!text) return ''
  if (text.startsWith('STALE')) {
    const old = [...text.matchAll(/(\d+)\(([^)]*)\)/g)]
    const which = old.length ? `（PID ${old.map(m => `${m[1]} ${m[2]}`).join('、')}）` : ''
    const kill = old.length ? `：! for p in ${old.map(m => m[1]).join(' ')}; do taskkill //PID $p //T //F; done` : ''
    return `Codex 已更新，但背景程式還是舊版${which}，派工會失敗；先關掉它${kill}`
  }
  if (/\bcodex=unavailable\b/.test(text)) return '找不到 Codex app，無法派工給 Codex'
  if (/\bcompanion=MISSING\b/.test(text)) return '找不到 Codex 串接腳本 codex-companion.mjs，無法派工給 Codex'
  if (/\bprocess-scan=unavailable\b/.test(text)) return '無法檢查 Codex 背景程式的版本'
  return `Codex 狀態不明（${text}）`
}
