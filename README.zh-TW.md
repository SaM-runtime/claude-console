# claude-console

<p align="center"><a href="docs/demo.mp4"><img src="docs/demo.gif" alt="claude-console 示範：主控台面板、專案表、動作選單、額度電池" width="900"></a></p>
<p align="center"><a href="docs/demo.mp4">▶ 觀看 30 秒介紹影片（MP4，示範資料）</a> · <a href="README.md">English</a></p>

`claude-console` 是本機多專案 Claude Code mod。單一主控台 session 負責各專案的規格、監督與審核關卡；操作者只提供決策，並在最後決定是否 release。

`console-status` mod 讀取精簡 STATUS 卡與受管理的執行器狀態，提供觸發式動作。驗證、派工、同步 STATUS 與審核都從按鈕直接開始，結果會寫入動態 feed。面板不會執行 release 或正式環境變更。

派工執行器可以切換。預設 `claude` 使用 Claude Code 原生背景 agent，不需要 Codex 帳號；Claude 額度有限時，可選 `codex` 改走 Codex Companion。

面板刷新會查詢本機檔案與 CLI，並在觀察結果變更時更新 mod 自有的受管理狀態；刷新本身不會請求模型。決策草稿只有在操作者送出後才使用 Claude 額度。目前 UI 為繁體中文。

## 需求

- Windows（目前只驗證此作業系統）
- Claude Code 2.1.289 以上，且支援 mod
- 一份專案登錄表，以及每個專案各一份 STATUS 檔
- 只有 `executor: codex` 需要 Node.js、PowerShell、Codex Companion 與 Codex 帳號；broker preflight 另需 Codex 桌面應用程式

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

展開的專案卡與右鍵選單中的 `執行者` Button 會輪換該專案的覆寫：沿用、`claude`、`codex`、`manual`。標籤會標示來源（`・面板` 是面板覆寫、`・登錄表` 是登錄表）。`/console project executor|model|effort <值|inherit> <專案名稱>` 設定相同欄位，`/console project` 列出實際生效的設定。

同一專案可能同時有兩種執行器的工作（切換執行者或 Claude 備援之後）。工作清單會合併兩種執行器；任一執行器有執行中或排隊中的工作，就顯示 RUNNING 並阻止重複派工。

面板標題下方的 executor、model、effort 都是 plain Button。點一下會輪換可選值、寫入檔案並顯示 toast；手機沒有 Client 時也會呈現 Button。設定套用到下一次派工，執行中的任務保留自己的請求值。

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

右鍵選單與展開的專案卡提供相同動作；手機使用卡片 Button。每個觸發會立即 toast、執行中轉圈並拒絕重複啟動，結束後把結果寫入動態。

| 動作 | 出現條件 | 行為 |
| --- | --- | --- |
| ▶ 執行驗證 | CARD 有 `驗證` | 在專案根目錄執行，最長五分鐘；不花模型額度 |
| ⇢ 同步 STATUS | SYNC，且執行者不是 `manual` | 派該專案的執行器只更新 CARD 與歷程 |
| ⇢ 繼續下一步 | IDLE、有下一步、無待決或關卡，且執行者不是 `manual` | 三秒內再按一次後派該專案的執行器 |
| ⇢ 改用 Claude 派工 | `codexFallback: ask` 擋下的 Codex 派工 | 把同一動作交給 Claude，並記錄為備援 |
| ✎ 做決定 | `等使用者` 非空 | 預填草稿並附一次性專案 context；送出時才使用 Claude |
| ⚑ 審核關卡／最終審核 | 可辨識的 spec、review、release | 交主控台 Claude 審核；release 審核不會執行 release |
| ↗ 開啟 STATUS.md | 一律 | 請編輯器開啟檔案 |

驗證會保存每個專案最新時間、exit status 與最後三行輸出。`驗證` 只能放可信任的本機檢查；它會透過 shell 執行，不得包含部署或正式環境操作。

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

選取專案只套用到下一則被接受的提示；下游拒絕提示時會保留選取，供重試使用。

## Workflow

[claude-console workflow](workflow/claude-console/SKILL.md) 定義主控台操作程序。日常讀取限於登錄表、CARD 與簡短的受管理工作摘要。

## 限制

- 內附探測目前需要 Windows 與 PowerShell。
- UI 目前只有繁體中文。
- 專案對應依賴設定的登錄表與 STATUS contract。
- 面板呈現本機證據，不能取代專案自己的驗證。
- 檔案每 60 秒刷新；process 探測會快取五分鐘，除非強制 refresh。
- Companion state 以根目錄最後一段名稱配對；同名根目錄可能混淆。
- 選取專案只附加一次 context，不會改變目前 cwd。

## 升級

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
node .task/check-docs.mjs
```

## License

MIT，見 [LICENSE](LICENSE)。
