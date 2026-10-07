import { expect, test } from 'claude-code/testing'
import { buildProject } from '../hooks/logic'
import { actionKinds, dispatchPrompt, confirmationMatches, outputTail, gatePrompt } from '../hooks/actions'

const project = (extra = '') => buildProject({ name: 'Project Alpha', statusPath: 'D:/Project Alpha/.console/STATUS.md' }, `<!-- CARD -->\n- 等使用者：無\n- 下一步：Run local tests\n- 驗證：\`node test.mjs\` → PASS\n${extra}\n<!-- /CARD -->`, [], 0)

test('project actions follow state and never continue across a decision or gate', () => {
  expect(actionKinds(project(), 'IDLE')).toEqual(['verify', 'continue', 'open'])
  expect(actionKinds(project(), 'SYNC')).toEqual(['verify', 'sync', 'open'])
  expect(actionKinds(project(), 'RUNNING')).toEqual(['verify', 'open'])
  expect(actionKinds(project('- 等使用者：Choose a colour'), 'ACTION')).toEqual(['verify', 'decide', 'open'])
  expect(actionKinds(project('- 關卡：release：Review evidence'), 'GATE')).toEqual(['verify', 'gate', 'open'])
  expect(actionKinds(project('- 關卡：future：Unknown gate'), 'IDLE')).toEqual(['verify', 'open'])
  expect(actionKinds(project('- 下一步：無'), 'IDLE')).toEqual(['verify', 'open'])
  expect(actionKinds(project('- 下一步：無（等使用者決定）'), 'IDLE')).toEqual(['verify', 'open'])
  expect(actionKinds(project('- 下一步：無(等決策)'), 'IDLE')).toEqual(['verify', 'open'])
})

test('dispatch prompts retain task scope and gate reviews use the renamed workflow', () => {
  const p = project()
  expect(dispatchPrompt(p, 'sync').startsWith('把最近完成的工作結果寫回 STATUS CARD，只改 CARD 與歷程，不做其他變更')).toBe(true)
  expect(dispatchPrompt(p, 'continue').startsWith('依 STATUS CARD 的下一步繼續；遵守任務骨架；結束時更新 CARD（含關卡欄）')).toBe(true)
  expect(dispatchPrompt(p, 'sync').includes('D:/Project Alpha/.console/STATUS.md')).toBe(true)
  expect(dispatchPrompt(p, 'continue').includes('不得執行正式環境變更')).toBe(true)
  expect(gatePrompt(project('- 關卡：review：Local changes')).startsWith('依 claude-console skill')).toBe(true)
})

test('continue confirmation expires at three seconds and binds to the displayed work', () => {
  expect(confirmationMatches({ at: 1000, signature: 'one' }, 'one', 3999)).toBe(true)
  expect(confirmationMatches({ at: 1000, signature: 'one' }, 'one', 4000)).toBe(false)
  expect(confirmationMatches({ at: 1000, signature: 'one' }, 'two', 1001)).toBe(false)
  expect(confirmationMatches(undefined, 'one', 1001)).toBe(false)
  expect(confirmationMatches({ at: 1000, signature: 'one' }, 'one', 999)).toBe(false)
  expect(outputTail('first\nsecond\nthird\nfourth\n', 'error\n')).toEqual(['third', 'fourth', 'error'])
})
