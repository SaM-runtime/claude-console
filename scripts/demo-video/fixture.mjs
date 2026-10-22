// Builds the projects the demo video switches to after /console demo: five git repositories with
// histories, a STATUS card each, and the registry that lists them. Nothing here calls a model.
// usage: node fixture.mjs <home>   (writes <home>/work/* and <home>/.claude/handoffs/projects-scope.md)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const home = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('usage: node fixture.mjs <home>')
const now = Date.now()
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const pad = n => String(n).padStart(2, '0')
const stamp = ago => { const d = new Date(now - ago); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }

function repo(name) {
  const dir = path.join(home, 'work', name)
  fs.mkdirSync(dir, { recursive: true })
  const git = (args, ago = 0) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com',
      GIT_AUTHOR_DATE: new Date(now - ago).toISOString(), GIT_COMMITTER_DATE: new Date(now - ago).toISOString() },
  })
  git(['init', '-q', '-b', 'main'])
  let n = 0
  const commit = (subject, ago, file = `src/${n}.txt`) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.appendFileSync(path.join(dir, file), `${subject}\n${n++}\n`)
    git(['add', '-A']); git(['commit', '-q', '-m', subject], ago)
  }
  const merge = (branch, ago) => git(['merge', '-q', '--no-ff', '-m', `Merge branch '${branch}'`, branch], ago)
  return { dir, git, commit, merge }
}

function status(dir, title, card, rest = '') {
  fs.mkdirSync(path.join(dir, '.console'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.console', 'STATUS.md'), `# ${title} STATUS\n\n<!-- CARD -->\n${card.map(line => `- ${line}`).join('\n')}\n<!-- /CARD -->\n${rest}`)
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.console/\n')
  // STATUS.md's own time counts as a write, so it is set to the CARD's 更新.
  return dir
}
const touch = (file, ago) => fs.utimesSync(file, new Date(now - ago), new Date(now - ago))

// shop-web: a decision waiting, a graph worth opening (merged and open branches, tags, unpushed work).
const shop = repo('shop-web')
shop.commit('建立專案骨架', 14 * DAY, 'README.md')
shop.commit('商品列表頁', 12 * DAY, 'src/list.js')
shop.commit('購物車', 10 * DAY, 'src/cart.js')
shop.git(['tag', 'v1.0.0'])
shop.git(['checkout', '-q', '-b', 'coupon'])
shop.commit('優惠碼欄位', 8 * DAY, 'src/coupon.js')
shop.commit('優惠碼驗證', 7 * DAY + 3 * HOUR, 'src/coupon.js')
shop.git(['checkout', '-q', 'main'])
shop.commit('修正購物車數量', 7 * DAY, 'src/cart.js')
shop.merge('coupon', 6 * DAY)
shop.commit('首頁效能調整', 4 * DAY, 'src/home.js')
shop.git(['tag', 'v1.1.0'])
shop.git(['checkout', '-q', '-b', 'onepage'])
shop.commit('一頁式結帳版型', 26 * HOUR, 'src/checkout.js')
shop.commit('一頁式結帳：手機版', 5 * HOUR, 'src/checkout.css')
shop.git(['checkout', '-q', 'main'])
shop.git(['checkout', '-q', '-b', 'steps'])
shop.commit('結帳步驟一：地址', 2 * DAY, 'src/steps.js')
shop.commit('結帳步驟二：付款', 22 * HOUR, 'src/steps.js')
shop.git(['checkout', '-q', 'main'])
shop.commit('更新相依套件', 6 * HOUR, 'package.json')
const origin = path.join(home, 'remotes', 'shop-web.git')
execFileSync('git', ['init', '-q', '--bare', origin])
shop.git(['remote', 'add', 'origin', origin])
shop.git(['push', '-q', 'origin', 'main', 'steps', '--tags'])
shop.git(['fetch', '-q', 'origin'])
shop.git(['checkout', '-q', 'steps'])
shop.git(['branch', '-q', '--set-upstream-to', 'origin/steps'])
shop.commit('結帳步驟三：確認頁', 3 * HOUR, 'src/steps.js')
fs.appendFileSync(path.join(shop.dir, 'src/steps.js'), 'export const confirm = true\n')
fs.writeFileSync(path.join(shop.dir, 'src/steps.css'), '.step { margin: 0 }\n')
touch(status(shop.dir, 'shop-web', [
  `更新：${stamp(25 * MIN)} · rev 9 · job c-7f3k2a · claude opus/high`,
  '狀態：兩種結帳版型都做好了，測試全過；等你選版型再收尾',
  `驗證：\`npm test\` → PASS（48 passed；verified ${stamp(25 * MIN)}）`,
  '執行中：無',
  '等使用者：結帳頁版型：A) 一頁式 B) 分三步；優惠碼欄位：1) 直接顯示 2) 收進「有優惠碼？」連結',
  '下一步：依選定的版型收尾，刪掉另一個分支',
  '關卡：無',
]) + '/.console/STATUS.md', 25 * MIN)

// api-server: a review gate for the console.
const api = repo('api-server')
api.commit('訂單 API', 9 * DAY, 'src/orders.ts')
api.commit('訂單 API 測試', 8 * DAY, 'test/orders.test.ts')
api.git(['checkout', '-q', '-b', 'paging'])
api.commit('訂單列表分頁', 3 * DAY, 'src/orders.ts')
api.commit('分頁的驗收測試', 2 * DAY, 'test/paging.test.ts')
api.git(['checkout', '-q', 'main'])
api.commit('錯誤訊息改成中文', 2 * DAY + 4 * HOUR, 'src/errors.ts')
api.git(['checkout', '-q', 'paging'])
api.commit('依審核意見補邊界測試', 3 * HOUR, 'test/paging.test.ts')
touch(status(api.dir, 'api-server', [
  `更新：${stamp(2 * HOUR)} · rev 14 · job c-q8w1e5 · claude sonnet/medium`,
  '狀態：訂單列表分頁改好，驗收通過，獨立審核也跑完了',
  '驗證：`npm test` → PASS（112 passed）',
  '執行中：無',
  '等使用者：無',
  '下一步：審核通過後合併，接著做退款 API',
  '關卡：review：訂單列表分頁（驗收 112 passed，審核任務已完成）',
]) + '/.console/STATUS.md', 2 * HOUR)

// docs-site: idle, with a next step to continue.
const docs = repo('docs-site')
docs.commit('文件站骨架', 20 * DAY, 'docs/index.md')
docs.commit('安裝說明', 9 * DAY, 'docs/install.md')
docs.commit('新版首頁', 6 * HOUR, 'docs/index.md')
touch(status(docs.dir, 'docs-site', [
  `更新：${stamp(5 * HOUR)} · rev 6 · job c-d2m9x1 · claude sonnet/medium`,
  '狀態：新版首頁上線，站內搜尋還是舊的',
  '驗證：`npm run build` → PASS',
  '執行中：無',
  '等使用者：無',
  '下一步：把站內搜尋換成 Pagefind，補上中文斷詞',
  '關卡：無',
]) + '/.console/STATUS.md', 5 * HOUR)

// mobile-app: something left to do and no CARD change for six days.
const mobile = repo('mobile-app')
mobile.commit('登入畫面', 15 * DAY, 'app/login.tsx')
mobile.commit('登入畫面改版', 6 * DAY, 'app/login.tsx')
touch(status(mobile.dir, 'mobile-app', [
  `更新：${stamp(6 * DAY)} · rev 3 · claude sonnet/medium`,
  '狀態：登入畫面改版完成，iOS 還沒測',
  '驗證：',
  '執行中：無',
  '等使用者：無',
  '下一步：在 iOS 模擬器跑一次登入流程測試',
  '關卡：無',
]) + '/.console/STATUS.md', 6 * DAY)

// data-jobs: the last verification failed.
const jobs = repo('data-jobs')
jobs.commit('每日報表', 11 * DAY, 'jobs/daily.py')
jobs.commit('報表改用 UTC+8', 70 * MIN, 'jobs/daily.py')
touch(status(jobs.dir, 'data-jobs', [
  `更新：${stamp(50 * MIN)} · rev 21 · job c-z5n0v8 · claude sonnet/high`,
  '狀態：每日報表的時區處理改了，有兩個測試沒過',
  '驗證：`pytest -q` → FAIL（2 failed）',
  '執行中：無',
  '等使用者：無',
  '下一步：修正 tests/test_daily.py 的兩個時區測試',
  '關卡：無',
]) + '/.console/STATUS.md', 50 * MIN)

const projects = [shop, api, docs, mobile, jobs].map(r => r.dir)
const registry = path.join(home, '.claude', 'handoffs', 'projects-scope.md')
fs.mkdirSync(path.dirname(registry), { recursive: true })
fs.writeFileSync(registry, ['# Project registry', '', '## STATUS 卡位置', '', '| Project | STATUS path |', '| --- | --- |',
  ...projects.map(dir => `| ${path.basename(dir)} | \`${dir}/.console/STATUS.md\` |`), ''].join('\n'))
console.log(JSON.stringify(projects))
