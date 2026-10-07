# claude-console

<p align="center"><a href="docs/demo.mp4"><img src="docs/demo.gif" alt="claude-console 示範：主控台面板、專案表、動作選單、額度電池" width="900"></a></p>
<p align="center"><a href="docs/demo.mp4">▶ 觀看 30 秒介紹影片（MP4，示範資料）</a> · <a href="README.md">English</a></p>

`claude-console` 是本機多專案 Claude Code mod。單一主控台 session 負責各專案的規格、監督與審核關卡；操作者只提供決策，並在最後決定是否 release。

`console-status` mod 讀取精簡 STATUS 卡與受管理的執行器狀態，提供觸發式動作。驗證、派工、同步 STATUS 與審核都從按鈕直接開始，結果會寫入動態 feed。面板不會執行 release 或正式環境變更。

派工執行器可以切換。預設 `claude` 使用 Claude Code 原生背景 agent，不需要 Codex 帳號；Claude 額度有限時，可選 `codex` 改走 Codex Companion。

面板刷新會查詢本機檔案與 CLI，並在觀察結果變更時更新 mod 自有的受管理狀態；刷新本身不會請求模型。決策草稿只有在操作者送出後才使用 Claude 額度。目前 UI 為繁體中文。

## 需求

- Windows 或 macOS（macOS 使用內附的 POSIX `sh` 探測腳本，不需要 PowerShell）
- Claude Code 2.1.289 以上，且支援 mod
- 一份專案登錄表，以及每個專案各一份 STATUS 檔
- 只有 `executor: codex` 需要 Node.js、Codex Companion 與 Codex 帳號。Windows 探測需要 PowerShell 與 Codex 桌面應用程式；macOS 探測需要 `PATH` 上有 `codex` CLI（會自動補上 Homebrew 路徑）

## 安裝

```powershell
claude plugin marketplace add SaM-runtime/claude-console
claude plugin install console-status@claude-console
```

直接使用這份 checkout：

```powershell
claude plugin marketplace add .
claude plugin install console-status@claude-console
```

Marketplace 管理請參考官方 [plugin marketplace 文件](https://code.claude.com/docs/en/plugins/cli-reference#plugin-marketplace-add)。

## 設定

`claude plugin configure` 接受每個值都是單行字串的 JSON object。未提供的設定保留原值。

```powershell
@'
{
  "registryPath": "C:\\Projects\\console\\projects-scope.md",
  "dispatchSettingsPath": "~/.claude/handoffs/dispatch.json",
  "claudeSessionsPath": "~/.claude/handoffs/claude-sessions.json",
  "executor": "claude",
  "defaultModel": "",
  "defaultEffort": "",
  "companionScript": "",
  "companionStateDir": "",
  "companionStateRoots": "",
  "modelsCachePath": "~/.codex/models_cache.json",
  "codexFallback": "ask",
  "codexMinQuotaPercent": "10"
}
'@ | claude plugin configure console-status@claude-console --values-stdin
```

| 項目 | 用途 | 預設值 |
| --- | --- | --- |
| `registryPath` | 專案名稱與 STATUS 檔的 Markdown 登錄表 | `~/.claude/handoffs/projects-scope.md` |
| `dispatchSettingsPath` | 共用執行器、模型與 effort 設定 | `~/.claude/handoffs/dispatch.json` |
| `claudeSessionsPath` | 受管理的 Claude session 對應檔 | `~/.claude/handoffs/claude-sessions.json` |
| `executor` | 設定檔缺少或無效時的執行器 | `claude` |
| `defaultModel` / `defaultEffort` | 模型備援值；空白交給執行器原生預設 | 空白 |
| `companionScript` | `executor: codex` 使用的 Companion 腳本；空白或已失效時自動改用最新安裝的 Codex plugin | 空白 |
| `companionStateDir` | 舊版 companion state 根目錄，也傳給 Codex preflight | 系統 Temp 的 `codex-companion` |
| `companionStateRoots` | 以字串編碼的 JSON 路徑陣列，覆寫 Codex job 來源 | 先 plugin data，再舊版 Temp |
| `modelsCachePath` | Codex 模型與 effort 快取 | `~/.codex/models_cache.json` |
| `codexFallback` | Codex 無法使用時的處理：`ask`、`claude`、`off` | `ask` |
| `codexMinQuotaPercent` | Codex 額度剩餘百分比低於此值時啟用備援 | `10` |
| `gitProbe` | `on`：每個專案的 Git 狀態（分支、未提交、未推送）以及透過 `gh` 讀取的 PR 與 CI 檢查；`git`：只讀本機 Git；`off`：都不讀（見 [Git、PR 與 CI](#gitpr-與-ci)） | `on` |
| `commandGuard` | `ask`：無法復原的 shell 指令先問你（見[指令護欄](#指令護欄)）；`deny`：一律拒絕；`off`：關閉 | `ask` |
| `cacheHint` | `on`：顯示主控台 prompt 快取倒數與重寫費用（見[快取與費用](#快取與費用)）；`off`：隱藏 | `on` |
| `cacheTtl` | `auto`（讀 session 記錄裡 API 回報的實際 TTL，讀到前先當 5 分鐘）、`5m` 或 `1h` | `auto` |
| `cacheWritePrice` | 估算用的快取寫入單價（每百萬 tokens 美元）；空白使用模型牌價 | 空白 |
| `autoSync` | `on`：執行者已結束、但結果沒寫回 CARD（待同步）時，主控台自動派一次同步，每個工作只派一次；失敗或沒寫回的同步不會重試。`off`：只有按「同步」才會同步 | `on` |
| `activation` | `auto`：只有執行過 `/console` 的 session 會跑主控台，resume 同一個 session 會自動再啟動；其他 session 只有指令護欄（見[輕量 session](#輕量-session)）。`always`：每個 session 都跑 | `auto` |
| `projectMode` | `auto`：在已登錄專案內開啟的 session 會切到專案模式（見[流程管線與專案模式](#流程管線與專案模式)）；`off`：一律是多專案主控台 | `auto` |

Windows、macOS、Linux 都會展開開頭的 `~`。變更 plugin 設定後，請執行 `/reload-plugins` 或開新 Claude Code session。登錄表格式見 [範例](workflow/projects-scope.example.md)。

## Dispatch settings（派工設定）

正式檔案是 `~/.claude/handoffs/dispatch.json`（`dispatchSettingsPath`），保存全域 executor、model、effort，以及可選的專案覆寫：

```json
{
  "executor": "claude", "model": "", "effort": "",
  "projects": {
    "D:/Projects/api": { "executor": "codex", "model": "", "effort": "high" },
    "D:/Projects/legacy-portal": { "executor": "manual" }
  }
}
```

沒有 `projects` 的 0.1 平面格式照常可用。`dispatch.json` 不存在時，會讀取同目錄的舊版 `codex-dispatch.json`（唯讀；舊檔沒有 `executor` 時視為 `codex`）。所有寫入都寫到 `dispatch.json`。

### 專案執行者

每個專案依下列順序決定執行者：

1. 面板覆寫：`dispatch.json` 的 `projects["<根目錄>"]`。Key 是專案根目錄；Windows 磁碟與 UNC 路徑不分大小寫比對。
2. 登錄表：登錄表表格可選的 `Executor` 欄（`claude`、`codex`、`manual` 或空白）。沒有此欄的登錄表照舊解析。
3. 全域：`executor` 欄位。

Model 與 effort 依相同順序。專案執行者與全域不同時，不沿用全域的 model 與 effort，因為那些值屬於另一個執行器。

`manual` 代表面板永不派工該專案：隱藏同步與繼續，卡片顯示交接提示；CARD、驗證、決策與關卡照常。

展開的專案卡與右鍵選單中的 `執行者` 一列提供 `沿用`（會標出沿用的值與來源）、`claude`、`codex`、`manual`，按一下即選定，目前的選擇以方括號標示。面板會立即更新，之後的 refresh 在背景執行。`/console project executor|model|effort <值|inherit> <專案名稱>` 設定相同欄位，`/console project` 列出實際生效的設定。

同一專案可能同時有兩種執行器的工作（切換執行者或 Claude 備援之後）。工作清單會合併兩種執行器；任一執行器有執行中或排隊中的工作，就顯示 RUNNING 並阻止重複派工。

面板標題下方的 executor、model、effort 都是 plain Button。點一下會在下一行展開該設定的可選值，目前的值以方括號標示，`預設` 代表交給執行器決定；點選一個值會寫入檔案並顯示 toast，點目前的值、`✕` 或再點一次標籤則收起。強度選項跟著所選模型。讀不到 Codex 模型快取時，模型只列 `預設` 和目前的值，並提示改用 `/console model <name>`。手機沒有 Client 時也會呈現 Button。設定套用到下一次派工，執行中的任務保留自己的請求值。

下列指令顯示或設定相同內容：

```text
/console executor
/console executor claude
/console model
/console model <name>
/console effort <level>
```

`/console model ""`、`/console effort ""` 會恢復所選執行器的預設。檔案不存在、損壞或無法讀取時，使用 `executor`、`defaultModel`、`defaultEffort`。

### executor: claude

這是預設執行器，使用 Claude Code 原生背景 agent，不需要 Codex Companion 或 Codex 帳號。

Mod 會在 `claudeSessionsPath` 保存專案與 session 的對應，以及每個專案最近 20 筆受管理工作。第一次派工以專案為工作目錄並用原生背景模式啟動，後續以對應的完整 session ID resume。Claude Code 2.1.289 的本機 help 記載了 `--bg`、`--resume`、`--continue`。Mod 以 `--bg` 搭配唯一的 `--name` 啟動，透過 agents 清單確認回傳的短 ID，再以保存的完整 session ID resume。它不使用 `--continue --bg`，因為這個組合會選擇該工作目錄最近的 session，而不是明確指定受管理 session。

`claude agents --json --all --cwd <專案根目錄>` 會列出執行中與已完成 agent。Mod 只接受 `cwd` 完全符合專案的 background agent，使用其短 `id`、完整 `sessionId`、`name`、`state`、`status`、`waitingFor`，並以 `claude logs <id>` 讀取輸出。派工必須透過唯一名稱對應到一個新產生的完整 session UUID 才會保存；無法唯一確認時保持未解狀態並阻止再次派工，後續刷新可恢復唯一具名的派工。Blocked 或 waiting 仍算執行中，查不到 agent 也不推定完成。本機樣本觀察到 `working`、`blocked` state 與 `busy`、`idle`、`waiting` status；文件定義的終止 state `done`、`failed`、`stopped` 會結束受管理工作。

Session 檔是 mod 自有狀態。內容損壞時會 fail closed，不會丟棄已保存的 session 身分。同一 mod process 內的寫入會序列化，因此請只讓一個主控台 process 寫入；不同 process 同時寫入不保證 atomic。Claude 派工不加入略過權限的旗標，沿用一般 Claude Code 權限流程。背景 agent 被 blocked 時，請在 Claude Code attach 該 agent，處理批准或輸入。

模型 Button 提供 CLI 已觀察到的 alias：`fable`、`opus`、`sonnet`；`/console model <name>` 也接受自由輸入。Effort 為 `low`、`medium`、`high`、`xhigh`、`max`。空值交給 Claude Code 決定。

Claude Code 官方 [agent view](https://code.claude.com/docs/en/agent-view) 是背景 agent 的檢視與控制介面；旗標的現行定義以 [CLI reference](https://code.claude.com/docs/en/cli-reference) 為準。此 mod 只保存延續專案所需的受管理 session 身分。

### executor: codex

Claude 額度有限時可選這個執行器。派工前先設定 `companionScript`，並確認 Codex Companion 能使用其帳號。

Codex 模型順序取自 `models_cache.json` 的 `models[].slug`。Effort 取自 `supported_reasoning_levels[].effort`；沒有模型專屬資料時，備援為 `low`、`medium`、`high`、`xhigh`。快取不可用時保留目前值，改用 `/console model <name>`；空的 model 或 effort 會省略對應旗標，使用 Codex 預設。

Job 預設先讀 `~/.claude/plugins/data/codex-openai-codex/state`，再讀舊版 Temp 根目錄。同 ID 使用較新的 `updatedAt`，缺少時採 state 時間；同時間保留先讀來源。可用例如 `"companionStateRoots": "[\"~/jobs/current\",\"~/jobs/legacy\"]"` 覆寫。這個設定不影響 Codex quota 或 preflight。

內附 preflight 會在 Codex 派工前檢查 companion 與 broker。Quota 取自本機最新可用 Codex 紀錄，可能過期。派工受理只代表 companion 收到工作；完成與審核仍要看 STATUS 證據與本機驗證。

#### Companion 自動選用

`companionScript` 空白，或 preflight 回報設定的檔案 `MISSING`（Codex plugin 每個版本安裝在各自的快取資料夾，更新後固定路徑會失效）時，mod 會在 `~/.claude/plugins/installed_plugins.json` 中 `codex@openai-codex` 的 installPath 與 `~/.claude/plugins/cache/openai-codex/codex/<版本>/scripts/codex-companion.mjs` 之間，選出實際存在腳本的最新語意版本。頁尾會顯示使用中的路徑並標示 `自動選用`；設定路徑失效時附上警告。

#### 額度與 broker 備援

每次 Codex 派工前會檢查最近的探測結果：

- Codex 額度電池顯示剩餘量（取最低的時間窗）低於 `codexMinQuotaPercent`，或
- preflight 回報此專案 workspace 的 broker 過期、找不到 Codex app／broker，或找不到 companion 腳本。

超過六小時的額度資料仍會顯示，但視為未知，不會單獨觸發備援。接著：

| `codexFallback` | 行為 |
| --- | --- |
| `ask`（預設） | 不派工。Toast 與專案卡說明原因，並提供 `⇢ 改用 Claude 派工`，把同一個提示交給 Claude。 |
| `claude` | 把同一個提示交給 Claude 執行器，並在工作上記錄 `fallbackFrom: "codex"` 與原因。 |
| `off` | 0.1 行為：一律派給 Codex。 |

Claude 代為執行的工作在任務清單標示 `codex→claude`。只有全域執行器是 `claude` 時才沿用其 model 與 effort，否則使用 Claude Code 預設。

#### CLAUDE.md 片段

把以下內容貼進使用者 `CLAUDE.md`，讓手動派工的主控台也依同一份檔案：

```markdown
## 派工設定
派工給任何執行器前，先讀 ~/.claude/handoffs/dispatch.json
（不存在時讀 ~/.claude/handoffs/codex-dispatch.json；不要寫入它）。
- 全域："executor"（claude | codex）、"model"、"effort"。
- 專案："projects"["<專案根目錄>"] 可設定 "executor"（claude | codex | manual）、
  "model"、"effort"；Windows 路徑不分大小寫比對。優先序：projects > 登錄表 Executor 欄 > 全域。
- 非空的 model/effort 各以單一 --model / --effort 傳入；空值省略。
- "manual" 代表不派工該專案，改為整理交接內容給使用者。
```

## STATUS 卡

每份 STATUS 檔包含一個以 `<!-- CARD -->`、`<!-- /CARD -->` 包住的機器可讀區塊，維持十行以內。Parser 認得 [範本](workflow/STATUS-template.md) 中的繁體中文 key，包括 `更新`、`狀態`、`驗證`、`等使用者`、`下一步`、`關卡`。

`關卡` 填 `無`、`spec：…`、`review：…` 或 `release：…`。無法辨識但非空的關卡也會阻止繼續。Git 專案可把本機 STATUS 放在 `.console/STATUS.md`，需要保持本機時加入該 repo 的 `.git/info/exclude`。

## 專案動作

右鍵選單（鍵盤可在游標所在列按 `m` 開啟、Esc 關閉）與展開的專案卡提供相同動作。選單會顯示專案狀態與管線、正在執行的任務（已跑時間與最後一行輸出），以及 CARD 的待決、關卡與下一步；因工作執行中而無法派工時，以「派工鎖定：…」文字說明，不再顯示無法按的按鈕；手機使用卡片 Button。每個觸發會立即 toast、執行中顯示已經過秒數並拒絕重複啟動，結束後把結果寫入動態。

| 動作 | 出現條件 | 行為 |
| --- | --- | --- |
| ▶ 執行驗證 | CARD 有 `驗證` | 在專案根目錄執行，最長五分鐘；不花模型額度 |
| ⇢ 同步 STATUS | SYNC，且執行者不是 `manual` | 派該專案的執行器只更新 CARD 與歷程；`autoSync: on` 時每個結束的工作會自動派一次 |
| ⇢ 繼續下一步 | IDLE、有下一步、無待決或關卡，且執行者不是 `manual` | 六秒內再按一次後派該專案的執行器（面板會顯示將派出的下一步） |
| ⇢ 改用 Claude 派工 | `codexFallback: ask` 擋下的 Codex 派工 | 把同一動作交給 Claude，並記錄為備援 |
| ✎ 做決定 | `等使用者` 非空 | 預填草稿並附一次性專案 context；送出時才使用 Claude |
| ⚑ 審核關卡／最終審核 | 可辨識的 spec、review、release | 交主控台 Claude 審核；release 審核不會執行 release |
| ↗ 開啟 STATUS.md | 一律 | 請編輯器開啟檔案 |

**什麼時候算待同步。** 只要 CARD 的「更新」時間落在工作開始的那一分鐘或之後，就算這個工作已經寫回：離開前更新過 CARD 的工作不會被判成待同步。只有結束時沒動到 CARD（或失敗）的工作，才會讓專案停在待同步。

**同步進度。** 同步時，專案的「同步」欄會顯示步驟 `● 派工 ─ ◉ 執行 ─ ○ 寫回 STATUS`（● 完成、◉ 進行中、○ 未到、✕ 停在這一步），下一行是執行者、目前階段與經過時間；橫帶顯示 `↻ 同步：執行中 1 分 20 秒`。CARD 的「更新」有變才算完成；同步結束卻沒改到 CARD 時會直接標出 `✕ 寫回 STATUS`，不會默默停在待同步。結果在畫面上保留五分鐘，也會跳一則提示。有工作或同步在跑時，主控台每 20 秒更新一次（平常每分鐘）。

選單開著時，一個鍵就能執行目前可用的動作：`v` 驗證、`s` 同步、`c` 繼續（仍需第二次確認）、`d` 決策、`g` 審核關卡、`o` 開啟 STATUS.md、`p` 開啟 PR。選單底部只列出該專案可用的鍵；不可用的動作按了不會有反應。

## Git、PR 與 CI

每次 refresh 會在各專案根目錄執行 `git status --porcelain=v2 --branch`（加上 `--no-optional-locks`，不會搶執行者需要的 index 鎖）。有安裝並登入 `gh` 時，`gh pr view` 讀取目前分支的 PR 與檢查：每五分鐘一次，檢查仍在跑時每分鐘一次，強制 refresh 或切換分支時立即讀取。兩者都不花模型額度。

- 專案表格多一欄 `Git`（寬度 80 欄以上），顯示最需要處理的一項：`✕衝突n` 合併衝突、`CI✕n` 開啟中 PR 的檢查失敗、`●n` 未提交或未追蹤檔案、`↑n` 未推送、`↓n` 落後上游、`CI…` 檢查進行中、`✓` 乾淨。
- 動作選單與展開的專案卡顯示分支與上游、領先／落後、未提交與未追蹤數量，以及 PR 的審查狀態與失敗檢查名稱，並提供 `↗ 開啟`（`gh pr view --web`，失敗時改用系統預設瀏覽器）。
- 開啟中的 PR 有檢查失敗時，橫帶以紅色顯示 `CI 失敗 n`。新的失敗會 toast 並寫入紅色動態；恢復通過與合併寫入綠色動態。
- 選取專案後，下一則提示會附上它的 Git 與 PR 資訊，主控台不用再問就知道分支與失敗的檢查。

`gitProbe` 設為 `git` 可略過 GitHub，設為 `off` 兩者都略過。專案根目錄不是 Git repo 時不顯示任何 Git 資訊。

驗證會保存每個專案最新時間、exit status 與最後三行輸出。`驗證` 只能放可信任的本機檢查；它會透過 shell 執行，不得包含部署或正式環境操作。CARD 由背景執行者寫入，因此面板會顯示完整指令；此專案未執行過的指令（新的或已被修改）須在 10 秒內再按一次才會執行，已確認的指令會依專案記住、跨 session 保留。

派工後會先樂觀顯示 RUNNING，直到受管理狀態刷新。受理不代表完成。GATE 為紫色，排序在 ACTION 之後、RUNNING 之前，直到對應 Claude 審核回合結束才解除。`prompt.fill` 在沒有 composer 或對話框佔用時可能拒絕；面板會回報失敗，不會代送決策。Remote Control composer 仍需實機驗收。

## 指令

| 指令 | 行為 |
| --- | --- |
| `/console` | 開啟或關閉面板 |
| `/console refresh` | 刷新檔案與慢速探測 |
| `/console band` | 顯示或隱藏輸入框上方橫條 |
| `/console plain` | 切換互動列與純文字列 |
| `/console demo` | 載入虛構資料；`refresh` 回到實際狀態 |
| `/console executor [claude|codex]` | 顯示或選擇執行器 |
| `/console model [name]` | 顯示選項或指定模型 |
| `/console effort [level]` | 顯示選項或指定 effort |
| `/console project` | 列出每個專案實際生效的執行者、model、effort |
| `/console project executor\|model\|effort <值\|inherit> <名稱>` | 設定或清除單一專案的覆寫 |
| `/console mode [auto\|console\|project]` | 顯示或選擇此 session 的專案模式 |
| `/console off` | 在此 session 停止主控台（護欄保留）；再輸入 `/console` 重新啟動 |
| `/console version` | 顯示目前安裝版本與最新版本 |
| `/console update` | `main` 上有新版時更新 console-status 並重新載入外掛 |

選取專案只套用到下一則被接受的提示；下游拒絕提示時會保留選取，供重試使用。

## 輕量 session

`activation: auto`（預設）時，新的 session 是輕量的：只有指令護欄和 `/console` 指令。它不會執行 git、`gh`、`claude agents` 或 Codex 探測，不顯示橫帶，不在 system prompt 或提示中加入任何內容，也不跳快取或更新提示。臨時開的小 session、`claude -p` 和背景執行者都會維持這樣。

在 session 中第一次使用 `/console` 指令（`version`、`update`、`off` 除外）時，主控台才會在該 session 啟動，並記住這個 session：之後 resume 或重新載入外掛都會自動再啟動，不用再輸入。`/console off` 讓該 session 回到輕量狀態。專案模式也要等該 session 用過 `/console` 才會啟動。把 `activation` 設為 `always` 可回到 0.6.0 以前每個 session 都跑主控台的行為。

## 流程管線與專案模式

每個專案都會以管線顯示它在 [workflow](workflow/claude-console/SKILL.md) 中的位置：**規格 → 實作 → 同步 → 驗證 → 審核 → 上線**。

| 標記 | 意義 |
| --- | --- |
| `●` 綠 | 已完成 |
| `◉` 青 | 執行者正在處理（在 `spec` 或 `review` 關卡下的工作算該關卡） |
| `◆` 琥珀／藍／紫 | 等待中：等使用者或等繼續（琥珀）、等同步（藍）、等關卡判斷（紫） |
| `✕` 紅 | 驗證失敗：以主控台最近一次執行同一指令的結果為準，否則看 CARD `驗證` 欄 `→` 後的結論 |
| `○` 灰 | 尚未到達 |

位置只由主控台已讀取的資料推得，優先序：執行中的工作 → 未同步的結果 → 關卡 → 驗證失敗 → 下一步。「等使用者」有內容時，目前階段會停在等待。依 workflow，`review` 與 `release` 關卡只在驗收通過後設定，因此視為驗證已完成。

專案表在寬度 64 欄以上會多一欄六個標記的「流程」；專案卡與動作選單會顯示含階段名稱的完整管線。

**專案模式。** 主控台 session（見[輕量 session](#輕量-session)）位於已登錄專案的根目錄（或其子目錄）時，主控台會跟隨該專案：

- 橫帶顯示該專案的管線與目前步驟，以及其他有待決或關卡的專案數；
- 面板最上方多一張專案卡（管線、下一步、動作、驗證），下方仍是原本的主控台；
- system prompt 多一段固定內容：專案的 STATUS 路徑與 CARD 規約（寫入前重讀、`rev + 1`、關卡只填一個值、到關卡就停、不做 release）。只要 session 還在同一個專案，這段內容就不會變，不會破壞 prompt 快取；
- 進度（各階段、目前步驟、下一步、待決、關卡）只在和上一次不同時，才附在下一則提示上。

`/console mode console` 在此 session 關閉專案模式，`/console mode project` 強制開啟，`/console mode auto` 依 `projectMode` 設定。

## 指令護欄

Bash 或 PowerShell 要執行無法復原的指令時，會先用 Claude Code 自己的提問對話框問你，列出原因與完整指令；即使權限模式或允許規則本來會直接放行也一樣。選「執行一次」才會執行；其他回答（或沒有人可問，例如 `claude -p`）都會拒絕，並告訴模型不要換個寫法達成同樣效果。每次決定都會寫入動態。

涵蓋：遞迴刪除（`rm -r`、`Remove-Item -Recurse`、`rd /s`，但 `node_modules`、`dist`、`build`、`.next`、`target`、`coverage`、`__pycache__` 等建置輸出與快取除外）、強制或鏡像推送與刪除遠端分支、`git reset --hard`、`git clean -f`、丟棄整個工作區變更、`git branch -D`、`git stash drop|clear`、改寫歷史、`DROP TABLE`／`TRUNCATE TABLE`、格式化磁碟與直接寫裝置、`terraform destroy`、大量 `kubectl delete`、`helm uninstall`、`docker system prune -a`、`gh repo|release delete`，以及發布（`npm|pnpm|yarn|cargo publish`、`gh release create`）。也會檢查 `bash -c`、`powershell -Command`、`cmd /c`、`eval`、`Invoke-Expression`／`iex` 裡的指令，看穿包裝指令與其選項（`sudo -u root`、`env`、`nice -n 10`、`timeout 60`、`xargs -0`），把經 `xargs` 執行的遞迴 `rm` 視為刪除管線傳入的所有項目，把 `-Recurse:$true` 視同 `-Recurse`，並攔下 `+分支` 強制推送、`push --prune`、`checkout -f`／`switch -f`、`find -delete` 與 `find -exec rm -r`。`--force-with-lease`、刪單一檔案、一般推送、試跑（`-n`、`--dry-run`、`-WhatIf`）、刪除暫存目錄裡的東西（`/tmp/…`、`$TMPDIR/…`、`$env:TEMP\…`）、PowerShell 對單一檔案的 `rm -Force`，以及只是搜尋或記錄文字的指令中出現的 SQL 字樣（`git commit -m "drop table…"`、`grep`）不會被攔。

只要啟用此外掛，每個 session 都有護欄，背景執行者也包含在內：背景 agent 碰到時會像其他提問一樣等待回答（attach 進去處理），沒有人可問的情況則直接拒絕。`commandGuard` 設為 `deny` 不詢問直接拒絕，設為 `off` 關閉。

## 快取與費用

主控台 session 的 prompt 快取從最後一次請求開始算，維持 5 分鐘（或 1 小時）；過期後下一則提示要以快取寫入價把整段 context 重寫一次。橫帶在快取有效時顯示 `快取 4m`（最後一分鐘改用秒數倒數並高亮，如 `快取 45s`），過期後顯示 `快取已冷 $0.90`；過期前一分鐘會 toast 提醒，在冷快取上送出提示時也會提醒。面板的 Claude 區塊顯示同一行（含 context 大小），以及 `本次花費`（本 session 依 API 牌價估算的費用）。剛安裝或 `/reload-plugins` 後，倒數會從 session 記錄裡最後一則回應接著算；讀不到記錄時，面板會先顯示 `下一則回應後開始倒數`，等下一則回應後才開始。回合進行中（面板顯示 `回應中，結束後重新倒數`）或 context 少於 20k tokens 時，橫帶不顯示。

估算方式：最後一次請求的 context tokens × 模型 input 牌價 × 1.25（5 分鐘 TTL）或 × 2（1 小時）；使用 gateway 或議價時可設定 `cacheWritePrice`。`cacheTtl: auto` 用的是 API 實際採用的 TTL：每則回應的 `usage.cache_creation` 會把快取寫入分成 `ephemeral_5m_input_tokens` 與 `ephemeral_1h_input_tokens`，Claude Code 把它記在 session 記錄裡，主控台每回合結束後讀取（面板標示 `1h・實際`）。還沒看到有寫入快取的回應前先當 5 分鐘（`5m・預設`）；若閒置 5–60 分鐘後的請求仍讀到大部分 context，則推測為 1 小時（`推測`）。結果會跨 session 記住。訂閱方案下這些是依 API 價格換算的參考值，不是實際扣款。

## Workflow

[claude-console workflow](workflow/claude-console/SKILL.md) 定義主控台操作程序。日常讀取限於登錄表、CARD 與簡短的受管理工作摘要。

## 與其他 plugin 並用

輸入框上方的區塊是所有 plugin 共用的。從 0.5.1 起，其他 plugin 畫在那裡的內容會疊在主控台那一列下面，不會被蓋掉。這是為了能和 [alan890104](https://github.com/alan890104) 的 [paste-preview](https://github.com/alan890104/claude-code-paste-preview)（MIT 授權）一起使用而加的：它會在輸入框上方顯示貼上圖片的縮圖，並開啟編輯器讓你標註。claude-console 沒有包含 paste-preview 的任何程式碼，請另外安裝：

```powershell
claude plugin marketplace add alan890104/claude-code-paste-preview
claude plugin install paste-preview@paste-preview
```

感謝 alan890104 製作 paste-preview。

## 限制

- 內附探測：Windows 用 PowerShell 腳本，macOS 與 Linux 用 `sh` 腳本（Linux 已有測試與模擬過期 broker 驗證，但未經日常使用）。在這兩個平台上，若 broker 的 `codex app-server` 啟動時間早於 Codex CLI 最近一次升級，會判定為 STALE。
- macOS 上找不到 `code` CLI 時，開啟 STATUS.md 改用 `open`。
- UI 目前只有繁體中文。
- 專案對應依賴設定的登錄表與 STATUS contract。
- 面板呈現本機證據，不能取代專案自己的驗證。
- 檔案每 60 秒刷新；process 探測會快取五分鐘，除非強制 refresh。`gh` 探測同樣五分鐘一次（檢查進行中時一分鐘），每個專案一次、最多同時四個。
- Companion state 以根目錄最後一段名稱配對；同名根目錄可能混淆。
- 選取專案只附加一次 context，不會改變目前 cwd。
- Codex 支援會讀取 Codex 外掛內部的 `state.json` 與 plugin cache 目錄結構。state 結構無法辨識時，companion 那一行會顯示警告；出現時請更新 console-status。
- 同一時間只讓一個主控台 session 派工。`claude-sessions.json` 的寫入在同一個 Claude Code process 內會排隊，若檔案被其他 process 改過也會拒絕覆寫；但外掛檔案 API 沒有 rename 或獨占建立，兩個主控台在同一瞬間寫入仍不保證安全。

## 升級

面板底部會顯示目前安裝版本與 `main` 上的最新版本（每次載入與每 30 分鐘檢查一次；發現新版時也會 toast 一次）。按 `⬆ 更新到 vX.Y.Z` 或輸入 `/console update`，會執行下面兩個指令，再自動 `/reload-plugins --force`。若 console-status 是從本機資料夾載入（從資料夾加入的 marketplace，或 `--plugin-dir`），這兩個指令只會重讀該資料夾，所以按鈕改在該資料夾執行 `git pull --ff-only`；資料夾不是 git clone、無法 fast-forward，或目前分支仍是舊版時，面板會顯示原因。若重新載入被拒絕或 20 秒內沒有發生，面板會提示你自己輸入 `/reload-plugins`。手動方式：

```powershell
claude plugin marketplace update claude-console
claude plugin update console-status@claude-console
```

接著執行 `/reload-plugins` 或開新 session。變更內容見 [CHANGELOG.md](CHANGELOG.md)。

## 開發檢查

```powershell
claude plugin validate .
claude plugin validate plugins/console-status
claude plugin test plugins/console-status
node scripts/check-docs.mjs
```

## License

MIT，見 [LICENSE](LICENSE)。
