# 跨領域 OSCE：GitHub 頁面與 GAS 部署

前端檔名：`interdisciplinary.html`，放在 OSCE2026 儲存庫根目錄。單領域 `index.html` 不變。
後端檔案：[gas/Code.gs](gas/Code.gs)。請建立新的 Apps Script 專案，勿覆蓋單領域後端。

## 1. 建立跨領域後端與資料表

1. 開啟 [Apps Script](https://script.google.com/)，新增專案，命名「115年跨領域OSCE評核」。
2. 將 [Code.gs](gas/Code.gs) 的全部內容貼入編輯器的 `Code.gs`，儲存。
3. 在上方函式選單選 `setupInterdisciplinary`，按「執行」，依 Google 提示授權存取試算表。
4. 執行記錄會顯示新建立的跨領域試算表連結。此表包含「評審帳號」「評核資料」「系統設定」。

不用先建立試算表或手動填 ID；程式會建立獨立表，並自動將 `SPREADSHEET_ID` 寫入指令碼屬性。
重跑初始化會保留評分和帳號；若設定誤指向非跨領域試算表，程式會停止操作。

## 2. 設定管理者與評審密碼

Apps Script 左側「專案設定」→「指令碼屬性」→新增下列四個屬性。值請填各帳號的正式密碼，每個 8–128 字元，不用傳到聊天或放進 GitHub。

| 屬性名稱 | 登入帳號 | 使用者 |
| --- | --- | --- |
| `PASSWORD_ADMIN` | `admin` | 管理者 |
| `PASSWORD_REVIEWER1` | `reviewer1` | 柯雅婷 督導 |
| `PASSWORD_REVIEWER2` | `reviewer2` | 劉韋呈 醫師 |
| `PASSWORD_REVIEWER3` | `reviewer3` | 蔡長志 主任 |

儲存屬性後，回編輯器執行 `setPasswordsFromProperties`。
設定成功會啟用帳號，將密碼轉為雜湊，並刪除四個暫存密碼屬性。密碼不以明文存在試算表。
將來改密碼，只需再填該帳號對應的屬性並重跑此函式；其他帳號不受影響。
不用修改 `AUTH_PEPPER`，改動它會讓既有密碼雜湊失效。

「評審帳號」工作表的 `active` 欄為 TRUE 才能登入；改為 FALSE 可停用帳號。
試算表保持管理者私有即可，不需分享給評審；評審透過網頁登入。

## 3. 部署 GAS 網頁應用程式

1. 右上角「部署」→「新增部署作業」。
2. 類型選「網頁應用程式」。
3. 「執行身分」選「我」（部署者）。
4. 「誰可以存取」選「所有人」（允許匿名存取服務；評核資料仍需程式內的帳號登入）。
5. 按「部署」，複製網頁應用程式網址，必須以 `/exec` 結尾，不要使用 `/dev`。

直接開啟 `/exec` 會看到 JSON 狀態，例如 `{"ok":true,"service":"interdisciplinary-2026-v1","transport":"POST"}`。這是 API 狀態頁，不是評核介面。

**程式改動後，須到「管理部署作業」編輯該部署、選擇新版本，再部署，才能更新正式 `/exec`。**
單純按儲存不會更新已部署版本。

## 4. 接上 interdisciplinary.html

在根目錄 `interdisciplinary.html` 的 `CONFIG` 設定區，將：

```js
apiUrl: "",
```

改為你的專用部署網址：

```js
apiUrl: "https://script.google.com/macros/s/你的部署ID/exec",
```

儲存並更新 GitHub `main`。也可以把新的 `/exec` 網址貼給我，我會幫你更新前端；部署網址不是密碼。
請不要填入原本單領域的端點，新版本採用 POST 協定，與原本 JSONP 後端不同。
前端 `apiUrl` 留空時仍是本機試用，頁面會明確顯示狀態，不會把試用分數自動搬進正式表。

GAS 預設允許前端來源 `https://luyun1224.github.io`，對應這個儲存庫的 GitHub Pages。
若使用自訂網域，在指令碼屬性 `ALLOWED_ORIGINS` 填完整來源，例如 `https://osce.example.org`；多個來源用逗號分隔，不包含路徑或結尾斜線。後端不接受未允許的來源。

## 5. GitHub Pages 頁面

若 OSCE2026 的 Pages 設定為「Deploy from a branch」→ `main` → `/ (root)`，更新 main 後頁面路徑為：

`https://luyun1224.github.io/OSCE2026/interdisciplinary.html`

原本單領域仍在 `/OSCE2026/`。
若尚未啟用 Pages，到儲存庫 Settings → Pages 設定上述發布來源，等發布完成再開啟網頁。

正式驗收請使用已發布的 HTTPS 頁面，不要直接雙擊本機 HTML 進行雲端登入：

1. `reviewer1` 以正式密碼登入，確認五組 PDF／影片可看。
2. 填十個 9.5 分與加分 10 分、說明文字，確認總分為 100，儲存後重新登入仍可讀到。
3. `reviewer2` 登入，確認看不到 `reviewer1` 的評分。
4. `admin` 登入，確認能讀到各委員分數並匯出 CSV。
5. 測試資料請由管理者在新試算表「評核資料」刪除對應資料列，保留表頭。不要清除單領域資料。

## 功能與試用

已加入五組：復健部-物理治療、臨床病理部、腦中風中心、品管部-01、品管部-02，各有 PDF 與影片。目前以單位名稱為標題，可在 `CONFIG.cases` 修改正式教案名稱。
PDF／影片可切換且保留輸入；切換會重新載入媒體，不保留影片播放時間。無法內嵌時可「另開視窗」。

| 評核分類 | 配分 |
| --- | ---: |
| 情境設置 | 10 |
| 教案指引（3 項） | 30 |
| 評分設計（2 項） | 20 |
| 教學目標明確一致 | 10 |
| 影片製作（3 項） | 30 |

最終總分 = **min(100, 基本分 + 優良加分)**；基本分 100，額外加分 0–10。
基本細項每項 0–10，以 0.5 分為單位，全部必填。加分須填優良表現說明。
前端、後端、平均、排名與 CSV 均使用 100 分封頂，保留基本分與原始加分。
三位評審皆完成才列正式名次，同分並列且跳號。

本機試用可執行 `python3 -m http.server 8010 --bind 127.0.0.1 --directory /workspace/OSCE2026`，由該伺服器讀取 `/interdisciplinary.html`。
`apiUrl` 留空時，評審為 `reviewer1`、`reviewer2`、`reviewer3`，管理者為 `demo_admin`，試用密碼皆為 `demo`；資料只存於該瀏覽器。
正式雲端模式的管理者帳號為 `admin`，密碼由你設定；不使用示範密碼。
本機儲存鍵為 `osce_cross_domain_2026_v1`，與單領域分開。

## 驗證範圍

- Chromium 功能檢查：五組資料、評分必填／範圍／加分說明、媒體切換、封頂、本機資料隔離、儲存後重新載入、三人完成與並列名次、CSV、手機版面。
- Chromium 模擬 GAS 回覆：POST 登入、token 讀取與儲存、登出、管理者總覽、requestId 校驗；登入密碼不放入 GET 網址，也不留在雲端 SESSION。
- 後端以 Node.js 模擬 GAS 服務的 8 項測試：`node --test gas/tests/backend.test.cjs`。包括分數及權限、密碼設定、登入限制、session、初始化保護與 POST 回覆。
- 上述自動化測試沒有部署 Google 專案或向正式試算表寫入資料。真實 GAS 部署／權限及正式評審登入需依上方步驟確認。
- 十個 Drive 預覽頁曾確認 HTTP 200 且可讀取檔名；完整 PDF 和影片播放需以正式評審瀏覽器確認。
- 雲端 session 最長六小時；Google 快取可能提前回收，此時重新登入即可。每次讀取／儲存都重新核對帳號是否啟用；改密碼會使舊 session 失效。
