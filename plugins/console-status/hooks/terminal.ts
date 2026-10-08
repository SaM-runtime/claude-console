/**
 * Process output can be a replayed terminal (`claude logs`): OSC links, cursor save/restore,
 * charset switches, bells. A UI text child may not hold a control character, so strip every
 * escape sequence and treat a bare carriage return as the start of a new line.
 */
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g

export function terminalLines(text: string): string[] {
  return text.replace(ESCAPES, '').split(/\r\n|\r|\n/).map(line => line.replace(/\t/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''))
}
