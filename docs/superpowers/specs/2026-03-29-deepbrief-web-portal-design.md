# DeepBrief AI — 內部研究入口網站設計文件

**日期：** 2026-03-29
**狀態：** 已核准

---

## 一、背景與目標

DeepBrief AI 目前是純 CLI 工具，需透過命令列執行。為讓內部同事能自助提交研究需求、非同步收取報告，新增一個 Web 入口頁面。

**核心需求：**
- 同事輸入「研究主題」與「Email」即可提交
- 即時顯示各階段執行進度
- 管線完成後自動寄出 `.docx` 報告至指定信箱
- 無需登入（內部工具，URL 本身作為存取控制）

---

## 二、整體架構

```
瀏覽器
  │
  ├─── Vercel（靜態前端）
  │     ├── /                表單頁（輸入主題 + email）
  │     └── /status/         進度追蹤頁（每 3 秒輪詢後端）
  │
  └─── Railway（Express API）
        ├── POST /api/jobs        建立任務，回傳 job_id
        ├── GET  /api/jobs/:id    查詢進度（供前端輪詢）
        ├── 執行 DeepBrief 管線   逐階段更新 Redis 狀態
        └── 完成後呼叫 Resend 寄信（附 .docx 與摘要卡）

狀態儲存：Upstash Redis（免費方案，每 job 存一個 hash）
Email 寄送：Resend API
```

---

## 三、任務狀態機

每個研究任務依序經歷以下 8 個狀態：

| 狀態 | 說明 |
|------|------|
| `queued` | 已建立，等待執行 |
| `planning` | 規劃研究架構（runPlanner） |
| `collecting` | 蒐集多源資料（runCollector） |
| `analyzing` | 分析合成（runAnalyzer） |
| `writing` | 撰寫報告 JSON（runReporter） |
| `reviewing` | 品質審稿迴圈（runReviewer） |
| `delivering` | 寄送 Email |
| `done` | 完成 |
| `error` | 失敗（附 error_message） |

---

## 四、前端設計

### 技術選型
- 純 HTML + Vanilla JS（無框架，零 build 複雜度）
- 部署至 Vercel 靜態托管
- 品牌色：Deep Navy `#001A4E`，延續現有 DeepBrief 視覺語言

### 4.1 表單頁 `/index.html`

**功能：**
- 研究主題輸入欄（placeholder 範例）
- Email 輸入欄（基本格式驗證）
- 送出按鈕：POST `/api/jobs`，取得 `job_id` 後導向 `/status/?id={job_id}`

**UI 元素：**
- DeepBrief AI header（深藍底色）
- 標語：「輸入主題，30 分鐘內收到報告」
- 預計完成時間提示

### 4.2 進度追蹤頁 `/status/index.html`

**URL 格式：** `/status/?id={job_id}`

**功能：**
- 每 3 秒 `GET /api/jobs/{id}` 輪詢
- 依 status 更新各階段顯示（✓ 完成 / ◉ 進行中 / ○ 待執行）
- 進行中階段顯示動態進度條動畫
- status = `done`：停止輪詢，顯示「報告已寄出」+ 再做一份按鈕
- status = `error`：顯示錯誤提示，提供重試入口

---

## 五、後端設計（Railway Express API）

### 5.1 檔案結構

```
深度商業研究/
├── server/
│   ├── index.js          # Express 入口，路由定義，CORS 設定
│   ├── jobRunner.js      # 執行管線、逐階段更新 Redis 狀態
│   ├── mailer.js         # Resend 寄信（附完整報告 + 摘要卡 .docx）
│   └── redis.js          # Upstash Redis REST API 封裝
├── public/               # Vercel 靜態前端
│   ├── index.html
│   └── status/
│       └── index.html
└── .env                  # 新增後端環境變數
```

### 5.2 API 端點

**`POST /api/jobs`**
- Body: `{ topic: string, email: string }`
- 驗證：topic 非空、email 格式正確
- 建立 Redis job hash，設定 status = `queued`
- 非同步啟動 `jobRunner`（不等待完成）
- 回傳：`{ jobId: string }`

**`GET /api/jobs/:id`**
- 回傳 Redis job hash 全部欄位
- 回傳格式：`{ id, topic, email, status, created_at, updated_at, error_message? }`

### 5.3 jobRunner 執行流程

**tmp 目錄隔離：** 每個 job 使用獨立的 `tmp/{jobId}/` 與 `output/{jobId}/` 目錄，避免並發 job 互寫同一路徑（`fileUtils.js` 的 `saveTmp`/`loadTmp` 透過傳入 jobId 決定子目錄）。

```js
async function runJob(jobId, topic, email) {
  const tmpDir = path.join(process.env.TMP_DIR || '/tmp', jobId);
  const outDir = path.join(process.env.OUTPUT_DIR || '/tmp/output', jobId);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const opts = { force: true, tmpDir, outDir };

  await updateStatus(jobId, 'planning');
  const plan = await runPlanner(topic, 'standard', opts);

  await updateStatus(jobId, 'collecting');
  const rawSources = await runCollector(plan, opts);

  await updateStatus(jobId, 'analyzing');
  const analysis = await runAnalyzer(rawSources, opts);

  await updateStatus(jobId, 'writing');
  // runReporter 回傳完整 report JSON（含 sections、sources 等）
  const report = await runReporter(plan, analysis, rawSources, opts);

  await updateStatus(jobId, 'reviewing');
  // runReviewer 回傳更新後的 report JSON（與輸入格式相同）
  const reviewedReport = await runReviewer(report, opts);

  // runDeliverer 呼叫 generate_docx.py，輸出 .docx 至 outDir，回傳 { docxPath, summaryPath }
  await updateStatus(jobId, 'delivering');
  const { docxPath, summaryPath } = await runDeliverer(reviewedReport, opts);

  // mailer.js 讀取 docxPath / summaryPath，以 Resend API 發送附件
  await sendEmail({ email, topic, docxPath, summaryPath });

  await updateStatus(jobId, 'done');
}
```

失敗時 catch error → `updateStatus(jobId, 'error', { error_message })`

**現有模組的 opts 傳遞：** `runPlanner`、`runCollector`、`runAnalyzer`、`runReporter`、`runReviewer`、`runDeliverer` 的 `options` 參數需新增 `tmpDir` 與 `outDir` 支援，供 `fileUtils.js` 決定讀寫路徑（向後相容：未傳時沿用 `.env` 預設值）。

### 5.4 Redis Job Hash 結構

```
KEY: job:{jobId}
FIELDS:
  id            string   UUID v4
  topic         string   研究主題
  email         string   收件人
  status        string   目前狀態
  created_at    ISO8601
  updated_at    ISO8601
  error_message string   (僅 error 狀態)
TTL: 7 天
```

### 5.5 Email 規格（Resend）

- **寄件人：** `DeepBrief AI <research@yourdomain.com>`
- **主旨：** `[DeepBrief] 「{topic}」研究報告已完成`
- **正文：** HTML，包含：報告標題、完成時間、使用來源數、附件說明
- **附件：** 完整報告 `.docx` + 摘要卡 `.docx`

---

## 六、部署架構

### Vercel（前端）
- 靜態檔案托管：`public/` 目錄
- 需要 `vercel.json` 指定輸出目錄：
  ```json
  { "outputDirectory": "public" }
  ```
- API URL 注入方式：在 `public/config.js` 中寫入 `window.API_URL`，由各 HTML 頁面載入此檔案取得後端位址（純靜態 HTML 無法使用 Vite 環境變數，故採此方案）
- 無 build step

### Railway（後端）
- Runtime：Node.js 20 + Python 3.11（用於 `generate_docx.py`）
- 需要 `nixpacks.toml` 同時安裝 Node.js 與 Python 依賴：
  ```toml
  [phases.setup]
  nixPkgs = ["python311", "python311Packages.pip"]

  [phases.install]
  cmds = ["npm install", "pip install python-docx"]

  [start]
  cmd = "node server/index.js"
  ```
- Redis 客戶端：使用 `@upstash/redis`（官方 SDK，自動處理序列化）
- CORS 設定：允許 Vercel 部署 URL（如 `https://deepbrief.vercel.app`），不使用萬用字元 `*`
- 環境變數：

```
ANTHROPIC_API_KEY=sk-ant-...
FIRECRAWL_API_KEY=fc-...
RESEND_API_KEY=re-...
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
ALLOWED_ORIGIN=https://deepbrief.vercel.app
PORT=3000
TMP_DIR=/tmp
OUTPUT_DIR=/tmp/output
```

### 啟動時孤立 job 清理
Railway 重啟（deploy 或 crash）時，正在執行的 job 會被中斷但 Redis 狀態仍停留在進行中狀態。`server/index.js` 啟動時執行一次掃描，將所有 status 不為 `done` / `error` / `queued` 的 job 標記為 `error`（error_message: `伺服器重啟，任務中斷，請重新提交`）。

---

## 七、不在範圍內（刻意排除）

- 使用者登入 / 帳號系統
- 研究歷史查詢功能
- 多語言支援
- 並發限制 / Rate limiting（內部工具暫不需要）

---

## 八、驗收標準

- [ ] 同事開啟 Vercel URL，填表單送出後跳至進度頁
- [ ] 進度頁每 3 秒更新，各階段依序標示為完成
- [ ] 管線跑完後，指定 email 收到含 `.docx` 附件的信件
- [ ] 出錯時進度頁顯示錯誤訊息（非白屏）
- [ ] Railway 重啟後進行中的 job 狀態標記為 error（不卡住）
