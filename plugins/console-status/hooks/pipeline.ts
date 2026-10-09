// The claude-console workflow as a pipeline: spec → build → sync → verify → review → release.
// Derived only from what the console already reads (CARD, executor jobs, the latest local
// verification); nothing here touches the disk. See workflow/claude-console/SKILL.md "Order of work".
import type { Project, VerificationResult } from '../types'
import { hasAsk, parseGate, saysNone } from './logic'

export type StageId = 'spec' | 'build' | 'sync' | 'verify' | 'review' | 'release'
/** done: passed · active: an executor is working on it · wait: needs the console or the user ·
 *  fail: evidence says it failed · todo: not reached. */
export type StageStatus = 'done' | 'active' | 'wait' | 'fail' | 'todo'
export type Stage = { id: StageId; label: string; status: StageStatus }
export type Pipeline = { stages: Stage[]; current: StageId | null; note: string }

export const STAGES: readonly { id: StageId; label: string }[] = [
  { id: 'spec', label: '規格' },
  { id: 'build', label: '實作' },
  { id: 'sync', label: '同步' },
  { id: 'verify', label: '驗證' },
  { id: 'review', label: '審核' },
  { id: 'release', label: '上線' },
]
const INDEX = Object.fromEntries(STAGES.map((stage, index) => [stage.id, index])) as Record<StageId, number>

const PASS = /\b(?:pass(?:ed)?|ok|green)\b|通過|成功|✓|✔/i
const FAIL = /\b(?:fail(?:ed|ing|ures?)?|error|red)\b|失敗|未通過|✕|✗|✘/i
/** A zero count names no failure: `214 pass, 0 fail`, `0 failed`, `failures: 0`, `0 失敗`. */
const ZERO_FAIL = /\b0\s*(?:fail(?:ed|ures?)?|errors?)\b|\b(?:fail(?:ed|ures?)?|errors?)\s*[:=]\s*0\b|\b0\s*個?失敗|失敗\s*[:：=]?\s*0\b/gi

/**
 * The verdict a CARD 驗證 line records after its command (`→ PASS; verified …`). FAIL wins over
 * PASS so `3 passed, 1 failed` reads as failed; neither word means no verdict.
 */
export function cardVerdict(note: string): 'pass' | 'fail' | null {
  if (FAIL.test(note.replace(ZERO_FAIL, ''))) return 'fail'
  if (PASS.test(note)) return 'pass'
  return null
}

/** Latest verdict: the console's own run when it ran this command, else what the CARD records. */
function verdict(p: Project, local?: VerificationResult): 'pass' | 'fail' | null {
  if (local && local.command === p.verify) return local.ok ? 'pass' : 'fail'
  return cardVerdict(p.verifyNote ?? '')
}

export function pipeline(p: Project, local?: VerificationResult): Pipeline {
  const todo = (): Stage[] => STAGES.map(stage => ({ ...stage, status: 'todo' }))
  if (!p.hasCard) return { stages: todo(), current: null, note: 'STATUS 卡不存在' }
  const gate = parseGate(p.gate)
  const gateStage: StageId | null = gate && gate.kind !== 'unknown' ? gate.kind as StageId : null
  const running = p.jobs.some(job => job.kind === 'running')
  const unsynced = !running && p.jobs.some(job => job.kind === 'newer')
  const result = verdict(p, local)
  const next = p.next.trim() && !saysNone(p.next)

  let current: StageId | null
  let status: StageStatus
  let note: string
  if (running) {
    // A job under a gate is that gate's work (acceptance tests for spec, the review job for review).
    current = gateStage === 'spec' || gateStage === 'review' ? gateStage : 'build'
    status = 'active'
    note = current === 'review' ? '審核任務執行中' : current === 'spec' ? '規格／驗收測試撰寫中' : '執行者實作中'
  } else if (unsynced) {
    current = 'sync'; status = 'wait'; note = '執行者已結束，結果待寫回 STATUS'
  } else if (gateStage) {
    current = gateStage; status = 'wait'
    note = gateStage === 'release' ? '待使用者核准上線範圍' : `待主控台審核 ${gateStage} 關卡`
  } else if (result === 'fail') {
    current = 'verify'; status = 'fail'; note = '驗證未通過'
  } else if (next) {
    current = 'build'; status = 'wait'; note = `待繼續：${p.next.trim()}`
  } else {
    current = null; status = 'todo'; note = '閒置'
  }
  if (hasAsk(p)) {
    status = 'wait'
    note = `需決策：${p.ask}`
    current ??= 'build'
  }

  const at = current === null ? -1 : INDEX[current]
  const stages = STAGES.map((stage, index): Stage => {
    if (index === at) return { ...stage, status }
    if (stage.id === 'verify') {
      // Verification is evidence, not a position: a failure shows wherever the work stands.
      if (result === 'fail') return { ...stage, status: 'fail' }
      if (result === 'pass' && (at === -1 || index < at)) return { ...stage, status: 'done' }
      // The workflow sets review/release only after acceptance is green.
      if (at > INDEX.verify) return { ...stage, status: 'done' }
      return { ...stage, status: 'todo' }
    }
    if (at === -1) return { ...stage, status: result === 'pass' && index < INDEX.verify ? 'done' : 'todo' }
    return { ...stage, status: index < at ? 'done' : 'todo' }
  })
  return { stages, current, note }
}

export const STAGE_GLYPH: Record<StageStatus, string> = { done: '●', active: '◉', wait: '◆', fail: '✕', todo: '○' }

// ── Project mode: a Claude Code session opened inside one registered project ──

const pathKey = (path: string) => {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(slashed) || slashed.startsWith('//') ? slashed.toLowerCase() : slashed
}

/** The registered project whose root is `cwd` or contains it (the deepest root wins). */
export function projectForCwd<P extends { statusPath: string }>(projects: readonly P[], cwd: string | null, rootOf: (statusPath: string) => string): P | null {
  if (!cwd) return null
  const here = pathKey(cwd)
  let best: P | null = null
  let bestLength = -1
  for (const project of projects) {
    const root = pathKey(rootOf(project.statusPath))
    if (!root || !(here === root || here.startsWith(root + '/'))) continue
    if (root.length > bestLength) { best = project; bestLength = root.length }
  }
  return best
}

/**
 * The system prompt section for project mode. It must not change while the session stays in the
 * same project (a changing system prompt re-sends the whole conversation uncached), so it holds
 * the project's identity and the CARD contract only; live progress goes with prompts instead.
 */
export function projectModeSection(p: Pick<Project, 'name' | 'statusPath'>): string {
  return [
    `【console-status 專案模式】這個工作階段位於已登錄專案「${p.name}」，STATUS：${p.statusPath}。`,
    '流程：規格 → 實作 → 同步 → 驗證 → 審核 → 上線（claude-console workflow）。',
    '- 動工前先讀 STATUS 的 CARD 區塊（<!-- CARD --> 到 <!-- /CARD -->），只讀需要的部分。',
    '- 完成一段工作就更新 CARD：這次動工時讀到的 rev 為準，寫入前再重讀，只有這兩次讀到的不同才停下回報衝突、不覆寫（不要跟記憶裡更早的 rev 比）；寫入 rev + 1、狀態、驗證（指令與實際結果）、下一步；更新欄寫現在的本機時間（先執行 date 或 Get-Date，不要猜）。',
    '- 關卡欄只放一個值：無／spec：…／review：…／release：…。到關卡就停下並附上證據；不自行清除關卡，不執行 release 或任何正式環境變更。',
    '- 需要使用者拍板的事寫進「等使用者」，不要自行決定。',
  ].join('\n')
}

/** What changed since the last prompt that carried progress: compare by this. */
export function progressSignature(p: Project, pl: Pipeline): string {
  return JSON.stringify([p.updated, p.next, p.ask, p.gate ?? '', pl.current, pl.stages.map(stage => stage.status)])
}

/** The per-prompt progress note in project mode. */
export function progressContext(p: Project, pl: Pipeline): string {
  const current = pl.stages.find(stage => stage.id === pl.current)
  const lines = [
    `【專案進度｜console-status】${p.name}：${pl.stages.map(stage => `${stage.label}${STAGE_GLYPH[stage.status]}`).join(' ')}`,
    `目前：${current ? `${current.label}（${pl.note}）` : pl.note}`,
  ]
  if (p.next.trim()) lines.push(`CARD 下一步：${p.next.trim()}`)
  if (hasAsk(p)) lines.push(`等使用者：${p.ask}`)
  const gate = parseGate(p.gate)
  if (gate) lines.push(`關卡：${p.gate}`)
  return lines.join('\n')
}
