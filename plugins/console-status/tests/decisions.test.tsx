import { expect, test } from 'claude-code/testing'

import { askSummary, parseAsk, pickDecision, splitClauses } from '../hooks/logic'

test('asks split into decisions on top-level semicolons, keeping bracketed commands whole', () => {
  expect(parseAsk('套用 patch（cd ~/p && patch -p1 < a.patch; echo ok）；決定是否處理窄螢幕')).toEqual([
    { title: '套用 patch（cd ~/p && patch -p1 < a.patch; echo ok）', options: [] },
    { title: '決定是否處理窄螢幕', options: [] },
  ])
  expect(parseAsk('一行\n兩行').map(d => d.title)).toEqual(['一行', '兩行'])
})

test('lettered, numbered and circled options become one option each', () => {
  expect(parseAsk('選配色：A) 深色 B) 淺色；保留資料：1) 保留 2) 清除')).toEqual([
    { title: '選配色', options: [{ key: 'A', text: '深色' }, { key: 'B', text: '淺色' }] },
    { title: '保留資料', options: [{ key: '1', text: '保留' }, { key: '2', text: '清除' }] },
  ])
  expect(parseAsk('連線 (A) proxy (B) secret')[0].options.map(o => o.key)).toEqual(['A', 'B'])
  expect(parseAsk('連線 ① proxy ② secret ③ 唯讀')[0].options.map(o => o.text)).toEqual(['proxy', 'secret', '唯讀'])
})

test('stray markers and lone letters are not options', () => {
  expect(parseAsk('視窗 1440/768/390 都 OK，要上線嗎')[0].options).toEqual([])
  expect(parseAsk('只有 A) 一個')[0].options).toEqual([])
  expect(parseAsk('Plan A. 先做，選 A：快 B：慢')[0]).toEqual({ title: 'Plan A. 先做，選', options: [{ key: 'A', text: '快' }, { key: 'B', text: '慢' }] })
})

test('summary folds options and counts decisions', () => {
  expect(askSummary('選配色：A) 深色 B) 淺色；保留資料：1) 保留 2) 清除')).toBe('2 項決策：選配色｜保留資料')
  expect(askSummary('只要一個決定')).toBe('只要一個決定')
})

test('a selected project with a decision lists every option on its own line', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2030-01-05T12:00:00Z') }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: JSON.stringify({ executor: 'claude' }) }))
  on('ui.open', () => ({ value: {} }))
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
    props: { bodyColumns: 60, scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  await ui.press({ key: 'sel-Project-Alpha' })
  expect(await ui.find({ type: 'Text', text: /^決策 1　選擇示範介面配色$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^決策 2　示範資料是否保留$/ })).toBeDefined()
  const labels = await Promise.all(['0-A', '0-B', '1-1', '1-2'].map(async id => (await ui.find({ key: 'sel-opt-' + id }))?.props.label))
  expect(labels).toEqual(['○ A) 深色主題', '○ B) 淺色主題', '○ 1) 保留', '○ 2) 清除'])
  await ui.unmount()
})

test('a long next step is listed one clause per line in the project detail', async ($, on) => {
  expect(splitClauses('改下拉（選項來自 BQ；顯示 id · name）；新增端點；不 commit')).toEqual(['改下拉（選項來自 BQ；顯示 id · name）', '新增端點', '不 commit'])
  on('clock.now', () => ({ value: Date.parse('2030-01-05T12:00:00Z') }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: JSON.stringify({ executor: 'claude' }) }))
  on('ui.open', () => ({ value: {} }))
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
    props: { bodyColumns: 60, scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  await ui.press({ key: 'detail' })
  expect((await ui.find({ type: 'Text', text: /^示範測試通過$/ }))?.text).toBe('示範測試通過')
  expect((await ui.find({ type: 'Text', text: /^等待配色選擇$/ }))?.text).toBe('等待配色選擇')
  await ui.unmount()
})

test('decision options are pressable rows and the primary button fills the composer with the answer', async ($, on) => {
  const fills: string[] = []
  on('clock.now', () => ({ value: Date.parse('2030-01-05T12:00:00Z') }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: JSON.stringify({ executor: 'claude' }) }))
  on('ui.open', () => ({ value: {} }))
  const closes: string[] = []
  on('ui.close', (_: any, e: any) => { closes.push(e.id); return { value: undefined } as any })
  on('prompt.fill', (_: any, e: any) => { fills.push(e.text); return { isFilled: true } })
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
    props: { bodyColumns: 60, scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  await ui.press({ key: 'sel-Project-Alpha' })
  expect((await ui.find({ key: 'sel-opt-0-A' }))?.props.label).toBe('○ A) 深色主題')
  await ui.press({ key: 'sel-opt-0-B' })
  await ui.press({ key: 'sel-opt-1-1' })
  expect((await ui.find({ key: 'sel-opt-0-B' }))?.props.label).toBe('● B) 淺色主題')
  expect((await ui.find({ key: 'sel-ask-submit' }))?.props.label).toBe('✎ 填入決策：1B 2-1')
  await ui.press({ key: 'sel-ask-submit' })
  expect(fills).toEqual(['「Project-Alpha」決策：1B 2-1'])
  // The pane stays open and keeps the picks lit after filling.
  expect(closes).toEqual([])
  expect((await ui.find({ key: 'sel-opt-0-B' }))?.props.label).toBe('● B) 淺色主題')
  expect((await ui.find({ key: 'sel-ask-submit' }))?.props.label).toBe('✎ 填入決策：1B 2-1')
  await ui.press({ key: 'sel-ask-clear' })
  expect((await ui.find({ key: 'sel-opt-0-B' }))?.props.label).toBe('○ B) 淺色主題')
  await ui.unmount()
})

test('a command in backticks stays one clause even with a half-width semicolon', () => {
  expect(splitClauses('跑 `cd app; npm test`；看結果')).toEqual(['跑 `cd app; npm test`', '看結果'])
  expect(splitClauses('`a; b`\nc; d')).toEqual(['`a; b`', 'c', 'd'])
  // An unclosed backtick ends at the line break, so later lines still split.
  expect(splitClauses('跑 `npm test\n下一行; 再一行')).toEqual(['跑 `npm test', '下一行', '再一行'])
})

test('digits answer the decisions in order and Backspace takes the last one back', () => {
  const decisions = parseAsk('選配色：A) 深色 B) 淺色；要不要上線；保留資料：1) 保留 2) 清除')
  expect(pickDecision(decisions, {}, '2')).toEqual({ '0': 'B' })
  // The decision without options is skipped.
  expect(pickDecision(decisions, { '0': 'B' }, '1')).toEqual({ '0': 'B', '2': '1' })
  // Once everything is answered, the next digit starts over.
  expect(pickDecision(decisions, { '0': 'B', '2': '1' }, '1')).toEqual({ '0': 'A' })
  expect(pickDecision(decisions, {}, '3')).toBeNull()
  expect(pickDecision(decisions, { '0': 'B', '2': '1' }, 'backspace')).toEqual({ '0': 'B' })
  expect(pickDecision(decisions, {}, 'backspace')).toBeNull()
})

test('in the action menu digits pick options and 做決定 carries them into the composer', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2030-01-05T12:00:00Z') }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: JSON.stringify({ executor: 'claude' }) }))
  on('ui.open', () => ({ value: {} }))
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'terminal',
    props: { bodyColumns: 60, scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  await ui.post({ menu: 'Project-Alpha' }, { in: 'rows' } as any)
  expect(await ui.find({ type: 'Text', text: /1–9 選選項/ })).toBeDefined()
  await ui.post({ key: '2' }, { in: 'rows' } as any)
  await ui.post({ key: '1' }, { in: 'rows' } as any)
  expect((await ui.find({ key: 'm-info-opt-0-B' }))?.props.label).toBe('● B) 淺色主題')
  expect((await ui.find({ key: 'm-info-ask-submit' }))?.props.label).toBe('✎ 填入決策：1B 2-1')
  await ui.post({ key: 'backspace' }, { in: 'rows' } as any)
  expect((await ui.find({ key: 'm-info-ask-submit' }))?.props.label).toBe('✎ 填入決策：1B 2：')
  await ui.unmount()
})

test('a narrow pane keeps the next step whole, a key hint that fits and the reset countdown', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2030-01-05T12:00:00Z') }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: JSON.stringify({ executor: 'claude' }) }))
  on('ui.open', () => ({ value: {} }))
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'terminal',
    props: { bodyColumns: 50, scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  expect(await ui.find({ type: 'Text', text: /^ⓘ ↑↓ Enter 選取・m 動作選單/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\d+時\d+分後重置/ })).toBeDefined()
  const next = await ui.find({ type: 'Text', text: /B\) 淺色主題/ })
  expect(next?.props.wrap).toBe('wrap')
  await ui.unmount()
})
