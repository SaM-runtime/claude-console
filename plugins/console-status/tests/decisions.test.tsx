import { expect, test } from 'claude-code/testing'

import { askSummary, parseAsk, splitClauses } from '../hooks/logic'

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
  on('ui.close', () => ({ value: undefined } as any))
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
  await ui.unmount()
})
