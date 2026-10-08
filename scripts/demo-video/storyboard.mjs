// The README demo: /console demo, the project table, the action menu, keyboard decisions, detail cards.
export default {
  cols: 150, rows: 50,
  steps: [
    { name: '一個指令｜/console demo 開啟主控台（示範資料）', run: async a => {
      await a.sleep(1000); await a.type('/console demo', 75); await a.sleep(500); await a.keys('Enter'); await a.sleep(3600) } },
    { name: '全部專案一張表｜狀態、流程管線、更新時間；左下橫帶隨時可見', run: async a => {
      for (const name of ['Project-Alpha', 'Project-Gamma', 'Sample-Docs', 'Project-Beta', 'Sample-API']) { const p = a.find(name + ' ', { minCol: 84 }); await a.moveTo(p.x + 4, p.y, 380); await a.sleep(250) }
      const b = a.find('示範資料  ●'); await a.moveTo(b.x + 14, b.y, 600); await a.sleep(1600) } },
    { name: '右鍵動作選單｜管線、待決、Git、可用動作與快捷鍵', run: async a => {
      const p = a.find('Project-Alpha ', { minCol: 84 }); await a.click(p.x + 4, p.y, 2); await a.sleep(2600) } },
    { name: '數字鍵做決策｜按 2 再按 1，答案就是 1B 2-1', run: async a => {
      const o = a.find('○ B)'); await a.moveTo(o.x + 6, o.y + 1, 500); await a.sleep(500)
      await a.keys('2'); await a.sleep(800); await a.keys('1'); await a.sleep(1600) } },
    { name: '一鍵填入｜選好的答案直接放進輸入框，Enter 送出', run: async a => {
      await a.clickText('✎ 填入決策', { dx: 6 }); await a.sleep(2800) } },
    { name: '各專案詳細｜審核關卡、PR 與 CI、執行中的任務', run: async a => {
      await a.clickText('✕ 關閉', { dx: 1 }); await a.sleep(600)
      await a.clickText('✕ 取消', { dx: 1 }); await a.sleep(600)
      await a.clickText('↧ 各專案詳細', { dx: 3 }); await a.sleep(1800)
      for (const name of ['Project-Gamma', 'Project-Beta', 'Sample-Docs']) { await a.clickText('▸ ' + name, { dx: 4 }); await a.sleep(2600) } } },
    { name: 'claude-console｜github.com/SaM-runtime/claude-console', run: async a => { a.hide(); await a.sleep(1800) } },
  ],
}
