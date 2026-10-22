// The README demo: /console demo, n through what waits on you, keyboard decisions, then the projects
// fixture.mjs builds (/console refresh): the branch graph, a commit opened in place, ⟳ 自動接力.
const PANE = 88 // the pane starts right of this column at 160 columns
const row = (a, name) => a.find(name + ' ', { minCol: PANE })

export default {
  cols: 160, rows: 50,
  steps: [
    { name: '一個指令｜/console demo 先看示範資料，不用任何專案', run: async a => {
      await a.sleep(1000); await a.type('/console demo', 75); await a.sleep(500); await a.keys('Enter'); await a.sleep(3400) } },
    { name: '全部專案一張表｜狀態、流程管線、更新時間；左下橫帶隨時可見', run: async a => {
      for (const name of ['Project-Alpha', 'Project-Gamma', 'Sample-Docs', 'Project-Beta', 'Sample-API']) { const p = row(a, name); await a.moveTo(p.x + 4, p.y, 360); await a.sleep(220) }
      const b = a.find('示範資料  ●'); await a.moveTo(b.x + 14, b.y, 600); await a.sleep(1500) } },
    { name: '按 n 看下一件等你的事｜決策、審核關卡、待同步，一件一件打開', run: async a => {
      const p = row(a, 'Sample-API'); await a.click(p.x + 4, p.y); await a.sleep(600)
      for (let i = 0; i < 3; i++) { await a.keys('n'); await a.sleep(1900) }
      await a.keys('n'); await a.sleep(900) } },
    { name: '數字鍵做決策｜按 2 再按 1，答案就是 1B 2-1', run: async a => {
      const o = a.find('○ B)'); await a.moveTo(o.x + 6, o.y + 1, 500); await a.sleep(400)
      await a.keys('2'); await a.sleep(800); await a.keys('1'); await a.sleep(1600) } },
    { name: '一鍵填入｜選好的答案直接放進輸入框，Enter 送出', run: async a => {
      await a.clickText('✎ 填入決策', { dx: 6 }); await a.sleep(2600); await a.keys('C-u'); await a.sleep(300) } },
    { name: '接上自己的專案｜每個專案資料夾輸入一次 /console add；/console refresh 讀實際狀態', run: async a => {
      a.hide(); await a.type('/console refresh', 60); await a.sleep(400); await a.keys('Enter'); await a.sleep(2800)
      for (const name of ['shop-web', 'api-server', 'docs-site', 'mobile-app', 'data-jobs']) { const p = row(a, name); await a.moveTo(p.x + 4, p.y, 340); await a.sleep(300) }
      await a.sleep(900) } },
    { name: '分支圖｜選單按 b：分支、合併、標籤與還沒推送的提交', run: async a => {
      const p = row(a, 'shop-web'); await a.click(p.x + 4, p.y, 2); await a.sleep(1400)
      await a.keys('b'); await a.sleep(1300)
      await a.wheel(p.x + 30, 30, 14, false, 70); await a.sleep(2600) } },
    { name: '點一個提交｜完整訊息與改了哪些檔案；✎ 附給 Claude 讓下一則提示帶著它', run: async a => {
      await a.clickText("Merge branch 'coupon'", { dx: 4 }); await a.sleep(900)
      const m = a.find("Merge branch 'coupon'"); await a.wheel(m.x + 20, 30, 7, false, 70); await a.sleep(800)
      a.shot(); await a.sleep(2400) } },
    { name: '⟳ 自動接力｜面板替你一路繼續、同步、送審核，停在需要你的地方', run: async a => {
      await a.keys('Escape'); await a.sleep(500)
      await a.wheel(PANE + 40, 20, 30, true, 25); await a.sleep(600)
      const p = row(a, 'docs-site'); await a.click(p.x + 4, p.y, 2); await a.sleep(1300)
      await a.hoverText('⟳ 自動接力', { dx: 3 }); await a.sleep(3200) } },
    { name: 'claude-console｜github.com/SaM-runtime/claude-console', run: async a => { a.hide(); await a.sleep(1800) } },
  ],
}
