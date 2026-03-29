# DeepBrief Web Portal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一個 Vercel 前端 + Railway 後端的 Web 入口，讓同事填寫主題與 Email 後即可觸發研究管線，並在進度頁即時追蹤各階段，完成後收到含 `.docx` 附件的報告信件。

**Architecture:** Vercel 托管純 HTML/JS 前端（表單頁 + 進度追蹤頁）；Railway 運行 Express API，以 UUID 為 job key 將任務存入 Upstash Redis，非同步執行現有 DeepBrief 管線，完成後用 Resend 寄信。每個 job 使用獨立 `tmp/{jobId}/` 與 `output/{jobId}/` 目錄隔離，避免並發互寫。

**Tech Stack:** Node.js 20, Express 4, @upstash/redis, Resend SDK, UUID v4；前端 Vanilla HTML/CSS/JS（僅用 textContent / createElement 操作 DOM，無 innerHTML 風險）；部署 Vercel (前端) + Railway (後端 + Python 3.11)

---

## Chunk 1: 環境配置與依賴安裝

### Task 1: 安裝後端新依賴

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安裝套件**

```bash
cd /Users/ark/深度商業研究
npm install express cors @upstash/redis resend uuid
```

- [ ] **Step 2: 確認套件已安裝 + package.json 已有 `"type": "module"`**

```bash
# 確認 express 已安裝
node -e "import('express').then(() => console.log('express OK'))"
# 確認 package.json 有 type:module（server/*.js 使用 import 語法需要此設定）
python3 -c "import json; p=json.load(open('package.json')); print('type:module OK' if p.get('type')=='module' else 'MISSING type:module in package.json')"
```

Expected: 兩行都輸出 OK。若 `"type": "module"` 缺失，手動在 `package.json` 加上此欄位。（本專案已有此設定，確認即可）

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add express, cors, upstash/redis, resend, uuid deps"
```

---

### Task 2: 建立 nixpacks.toml（Railway Python + Node.js）

**Files:**
- Create: `nixpacks.toml`

- [ ] **Step 1: 建立檔案**

```toml
[phases.setup]
nixPkgs = ["python311"]

[phases.install]
cmds = [
  "npm ci --production",
  "pip install python-docx"
]

[start]
cmd = "node server/index.js"
```

注意：只在 `nixPkgs` 列 `python311`；`pip` 由 Python 3.11 內建提供，不需額外指定 `python311Packages.pip`（該 Nix 屬性路徑在多數 nixpkgs channel 下不存在）。

- [ ] **Step 2: 本機驗證語法正確**

```bash
python3 -c "import tomllib; tomllib.load(open('nixpacks.toml','rb')); print('TOML OK')"
```

Expected: `TOML OK`

- [ ] **Step 3: Commit**

```bash
git add nixpacks.toml
git commit -m "chore: add nixpacks.toml for Railway Node.js + Python runtime"
```

---

### Task 3: 建立 vercel.json 與 public/config.js

**Files:**
- Create: `vercel.json`
- Create: `public/config.js`

- [ ] **Step 1: 建立目錄**

```bash
mkdir -p public/status
```

- [ ] **Step 2: 建立 vercel.json**

```json
{
  "outputDirectory": "public",
  "cleanUrls": true,
  "trailingSlash": false
}
```

- [ ] **Step 3: 建立 public/config.js**

```js
// public/config.js
// 部署前將 API_URL 改為 Railway 服務的實際 URL
window.API_URL = 'http://localhost:3000';
```

- [ ] **Step 4: Commit**

```bash
git add vercel.json public/config.js
git commit -m "chore: add vercel.json and public/config.js scaffold"
```

---

## Chunk 2: fileUtils per-job 路徑隔離

### Task 4: 修改 fileUtils.js 支援自訂 tmpDir / outDir

**Files:**
- Modify: `src/utils/fileUtils.js`

核心策略：為 `saveTmp`, `loadTmp`, `tmpPath`, `outputPath` 加上可選的 `dir` 參數。不傳時行為與現在完全相同（向後相容）。

- [ ] **Step 1: 撰寫測試腳本 scripts/test-fileutils.js**

```js
#!/usr/bin/env node
import { saveTmp, loadTmp, tmpPath } from '../src/utils/fileUtils.js';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

const jobDir = '/tmp/test-job-abc123';
if (existsSync(jobDir)) rmSync(jobDir, { recursive: true });

saveTmp('test.json', { hello: 'world' }, jobDir);
console.assert(existsSync(join(jobDir, 'test.json')), 'FAIL: saveTmp 未寫入自訂 dir');
console.log('PASS saveTmp 寫入自訂 dir');

const loaded = loadTmp('test.json', jobDir);
console.assert(loaded?.hello === 'world', 'FAIL: loadTmp 讀回錯誤');
console.log('PASS loadTmp 從自訂 dir 讀取');

saveTmp('default-test.json', { default: true });
const d = loadTmp('default-test.json');
console.assert(d?.default === true, 'FAIL: 預設行為壞了');
console.log('PASS 預設行為不變');

const p = tmpPath('foo.json', jobDir);
console.assert(p === join(jobDir, 'foo.json'), 'FAIL: tmpPath 路徑錯誤');
console.log('PASS tmpPath 正確');

// Test 5: outputPath 接受自訂 dir
import { outputPath } from '../src/utils/fileUtils.js';
const customOut = '/tmp/test-out-abc123';
const op = outputPath('report.docx', customOut);
console.assert(op === join(customOut, 'report.docx'), 'FAIL: outputPath 自訂 dir 路徑錯誤');
console.log('PASS outputPath 自訂 dir 正確');

rmSync(jobDir, { recursive: true });
if (existsSync(customOut)) rmSync(customOut, { recursive: true });
console.log('\n全部測試通過');
```

- [ ] **Step 2: 執行測試，確認 FAIL（函式尚未修改）**

```bash
node scripts/test-fileutils.js
```

Expected: AssertionError（`saveTmp` 目前不接受第三個參數）

- [ ] **Step 3: 修改 src/utils/fileUtils.js**

```js
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DEFAULT_TMP_DIR    = join(ROOT, process.env.TMP_DIR    || 'tmp');
const DEFAULT_OUTPUT_DIR = join(ROOT, process.env.OUTPUT_DIR || 'output');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function saveTmp(filename, data, dir = DEFAULT_TMP_DIR) {
  ensureDir(dir);
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  return path;
}

export function loadTmp(filename, dir = DEFAULT_TMP_DIR) {
  const path = join(dir, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveOutput(filename, content, encoding = 'utf-8') {
  ensureDir(DEFAULT_OUTPUT_DIR);
  const path = join(DEFAULT_OUTPUT_DIR, filename);
  writeFileSync(path, content, encoding);
  return path;
}

export function tmpPath(filename, dir = DEFAULT_TMP_DIR) {
  ensureDir(dir);
  return join(dir, filename);
}

export function outputPath(filename, dir = DEFAULT_OUTPUT_DIR) {
  ensureDir(dir);
  return join(dir, filename);
}

export function rootPath(...parts) {
  return join(ROOT, ...parts);
}
```

- [ ] **Step 4: 執行測試，確認全部通過**

```bash
node scripts/test-fileutils.js
```

Expected:
```
PASS saveTmp 寫入自訂 dir
PASS loadTmp 從自訂 dir 讀取
PASS 預設行為不變
PASS tmpPath 正確
PASS outputPath 自訂 dir 正確

全部測試通過
```

- [ ] **Step 5: 確認現有 CLI 管線不受影響**

```bash
node src/modules/planner.js --topic "測試" 2>&1 | tail -3
```

Expected: `[PLANNER]` 日誌，無 TypeError

- [ ] **Step 6: Commit**

```bash
git add src/utils/fileUtils.js scripts/test-fileutils.js
git commit -m "feat: fileUtils accepts custom tmpDir/outDir for per-job isolation"
```

---

### Task 5: 更新各模組支援 opts.tmpDir / opts.outDir

**Files:**
- Modify: `src/modules/reviewer.js`
- Modify: `src/modules/deliverer.js`
- Modify: `src/modules/planner.js`
- Modify: `src/modules/collector.js`
- Modify: `src/modules/analyzer.js`
- Modify: `src/modules/reporter.js`

**規律性改法（以 planner.js 為例，collector/analyzer/reporter 相同）：**

在 `runPlanner(topic, depth, options)` 函式頂部加：
```js
const tmpDir = options.tmpDir;
```
然後所有 `saveTmp(cacheKey, ...)` 改為 `saveTmp(cacheKey, ..., tmpDir)`，
所有 `loadTmp(cacheKey)` 改為 `loadTmp(cacheKey, tmpDir)`。

- [ ] **Step 1: 修改 src/modules/planner.js（加 tmpDir 透傳）**

在 `runPlanner` 中加 `const tmpDir = options.tmpDir;`，
`loadTmp(cacheKey)` → `loadTmp(cacheKey, tmpDir)`，
`saveTmp(cacheKey, plan)` → `saveTmp(cacheKey, plan, tmpDir)`。

- [ ] **Step 2: 同樣方式修改 src/modules/collector.js**

- [ ] **Step 3: 同樣方式修改 src/modules/analyzer.js**

- [ ] **Step 4: 同樣方式修改 src/modules/reporter.js**

reporter.js 另需修改 `extractSources` 內的 `loadTmp('raw_sources.json')` →
`loadTmp('raw_sources.json', options.tmpDir)`。

- [ ] **Step 5: 修改 src/modules/reviewer.js**

```js
// 修改 runCJKScanner 接受 tmpDir 參數：
function runCJKScanner(reportContent, tmpDir) {
  const inputPath = tmpPath('report_content.json', tmpDir);
  // ... 其餘不變
}

// 修改 runReviewer：
export async function runReviewer(reportContent, options = {}) {
  const tmpDir = options.tmpDir;
  // ...
  const cjkViolations = runCJKScanner(currentReport, tmpDir);
  // ...
  saveTmp('review_log.json', reviewLog, tmpDir);
  // ...
}
```

- [ ] **Step 6: 修改 src/modules/deliverer.js**

```js
import { readdirSync } from 'fs';  // 新增此 import

export async function runDeliverer(reportContent, options = {}) {
  const tmpDir = options.tmpDir;
  const outDir = options.outDir || outputPath('').replace(/\/$/, '');

  // 確保 outDir 存在
  mkdirSync(outDir, { recursive: true });

  const topic = reportContent.meta?.topic || 'report';
  const safeTopicShort = topic.slice(0, 20).replace(/[/\\?%*:|"<>]/g, '_');
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // 儲存 final JSON
  saveTmp('report_content_final.json', reportContent, tmpDir);
  const finalJsonPath = tmpPath('report_content_final.json', tmpDir);

  // 呼叫 python docx generator
  try {
    callDocxGenerator(finalJsonPath, outDir);
  } catch (err) {
    logger.error('DELIVERER', `docx 生成失敗：${err.message}`);
  }

  // 找到生成的 .docx 路徑
  let docxPath = null;
  let summaryPath = null;
  try {
    const files = readdirSync(outDir);
    const fullReport = files.find(f => f.includes('完整報告') && f.endsWith('.docx'));
    const summary    = files.find(f => f.includes('摘要卡')   && f.endsWith('.docx'));
    if (fullReport) docxPath    = join(outDir, fullReport);
    if (summary)    summaryPath = join(outDir, summary);
  } catch { /* 不影響主流程 */ }

  // 生成來源清單 .md
  const sourcesMarkdown = buildSourcesMarkdown(reportContent);
  const sourcesFilePath = join(outDir, `${safeTopicShort}_來源清單_${dateStr}.md`);
  writeFileSync(sourcesFilePath, sourcesMarkdown, 'utf-8');
  logger.info('DELIVERER', `來源清單已生成：${sourcesFilePath}`);

  return { outputDir: outDir, topic, dateStr, docxPath, summaryPath };
}
```

**必須**在 deliverer.js 頂部加上以下 import（當前版本均缺少）：
```js
import { readdirSync, mkdirSync } from 'fs';   // 新增 readdirSync, mkdirSync
import { join } from 'path';                     // 新增 join（當前 deliverer.js 無此 import）
```

- [ ] **Step 7: 驗證 CLI 管線不受影響（快取）**

```bash
node src/index.js --topic "台灣半導體產業 2026 展望" --resume-from deliverer 2>&1 | tail -5
```

Expected: DELIVERER 日誌，無 TypeError

- [ ] **Step 8: Commit**

```bash
git add src/modules/planner.js src/modules/collector.js \
        src/modules/analyzer.js src/modules/reporter.js \
        src/modules/reviewer.js src/modules/deliverer.js
git commit -m "feat: all pipeline modules support opts.tmpDir/outDir for job isolation"
```

---

## Chunk 3: 後端 API 伺服器

### Task 6: 建立 server/redis.js

**Files:**
- Create: `server/redis.js`

- [ ] **Step 1: 建立 server/ 目錄，建立 server/redis.js**

```bash
mkdir -p server
```

```js
// server/redis.js
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const JOB_TTL      = 60 * 60 * 24 * 7; // 7 天
const ACTIVE_INDEX = 'active_jobs';      // Redis Set，追蹤進行中 job ID
// 注意：Upstash 免費層不支援 KEYS 命令，改用 Redis Set 維護活躍 job 索引

export async function createJob(id, topic, email) {
  const now = new Date().toISOString();
  const job = { id, topic, email, status: 'queued', created_at: now, updated_at: now };
  await redis.hset(`job:${id}`, job);
  await redis.expire(`job:${id}`, JOB_TTL);
  await redis.sadd(ACTIVE_INDEX, id);  // 加入活躍索引
  return job;
}

export async function getJob(id) {
  return redis.hgetall(`job:${id}`);
}

export async function updateJobStatus(id, status, extra = {}) {
  await redis.hset(`job:${id}`, {
    status,
    updated_at: new Date().toISOString(),
    ...extra,
  });
  // done / error 時從活躍索引移除
  if (status === 'done' || status === 'error') {
    await redis.srem(ACTIVE_INDEX, id);
  }
}

export async function getActiveJobs() {
  // 使用 Redis Set 取得活躍 job ID（避免使用 KEYS 命令）
  const ids = await redis.smembers(ACTIVE_INDEX);
  if (!ids.length) return [];
  return Promise.all(ids.map(id => redis.hgetall(`job:${id}`)));
}
```

- [ ] **Step 2: 驗證語法**

```bash
node --input-type=module <<'EOF'
import './server/redis.js';
console.log('redis.js syntax OK');
EOF
```

Expected: `redis.js syntax OK`

---

### Task 7: 建立 server/index.js

**Files:**
- Create: `server/index.js`

- [ ] **Step 1: 建立 server/index.js**

```js
// server/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { createJob, getJob, updateJobStatus, getActiveJobs } from './redis.js';
import { runJob } from './jobRunner.js';

const app  = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5500';

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// POST /api/jobs — 建立研究任務
app.post('/api/jobs', async (req, res) => {
  const { topic, email } = req.body || {};

  if (!topic?.trim())
    return res.status(400).json({ error: '研究主題不可為空' });
  if (!email?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
    return res.status(400).json({ error: 'Email 格式不正確' });

  const jobId = uuidv4();
  await createJob(jobId, topic.trim(), email.trim());

  // 非同步啟動（不 await）
  runJob(jobId, topic.trim(), email.trim()).catch(async (err) => {
    await updateJobStatus(jobId, 'error', { error_message: err.message });
  });

  res.status(201).json({ jobId });
});

// GET /api/jobs/:id — 查詢任務狀態
app.get('/api/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '找不到此任務' });
  res.json(job);
});

// GET /health — 健康檢查
app.get('/health', (_req, res) => res.json({ ok: true }));

// 啟動時清理孤立 job
async function cleanupStaleJobs() {
  const ACTIVE_STATUSES = ['planning','collecting','analyzing','writing','reviewing','delivering'];
  try {
    const jobs = await getActiveJobs();
    let count = 0;
    for (const job of jobs) {
      if (ACTIVE_STATUSES.includes(job.status)) {
        await updateJobStatus(job.id, 'error', {
          error_message: '伺服器重啟，任務中斷，請重新提交',
        });
        count++;
      }
    }
    if (count) console.log(`[STARTUP] 清理 ${count} 個孤立 job`);
  } catch (err) {
    console.warn('[STARTUP] 清理孤立 job 失敗（非致命）:', err.message);
  }
}

// 先清理孤立 job，再開始接受請求（避免請求進來時 cleanup 尚未完成）
cleanupStaleJobs().then(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] DeepBrief API 啟動於 port ${PORT}`);
  });
});
```

- [ ] **Step 2: 確認 .env 有測試用環境變數**

`.env` 需包含（先用佔位符，正式值後填）：
```
UPSTASH_REDIS_REST_URL=https://placeholder.upstash.io
UPSTASH_REDIS_REST_TOKEN=placeholder
ALLOWED_ORIGIN=http://localhost:5500
RESEND_API_KEY=re-placeholder
```

- [ ] **Step 3: 啟動 server 並測試 /health**

```bash
node server/index.js &
sleep 2
curl -s http://localhost:3000/health
pkill -f "node server/index.js"
```

Expected: `{"ok":true}` 或 Upstash 連線錯誤（無 SyntaxError）

- [ ] **Step 4: Commit**

```bash
git add server/index.js server/redis.js
git commit -m "feat: Express API server with job routes and startup stale-job cleanup"
```

---

## Chunk 4: 管線整合與 Email 寄送

### Task 8: 建立 server/mailer.js

**Files:**
- Create: `server/mailer.js`

- [ ] **Step 1: 建立 server/mailer.js**

```js
// server/mailer.js
import { Resend } from 'resend';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = process.env.RESEND_FROM || 'DeepBrief AI <research@deepbrief.ai>';

export async function sendReportEmail({ email, topic, docxPath, summaryPath }) {
  const attachments = [];

  if (docxPath && existsSync(docxPath)) {
    attachments.push({
      filename: basename(docxPath),
      content:  readFileSync(docxPath).toString('base64'),
    });
  }
  if (summaryPath && existsSync(summaryPath)) {
    attachments.push({
      filename: basename(summaryPath),
      content:  readFileSync(summaryPath).toString('base64'),
    });
  }

  return resend.emails.send({
    from: FROM,
    to:   [email],
    subject: `[DeepBrief] 「${topic}」研究報告已完成`,
    html: buildEmailHtml(topic),
    attachments,
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmailHtml(topic) {
  const safeText = escapeHtml(String(topic).slice(0, 100));
  return [
    '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">',
    '<div style="background:#001A4E;color:#fff;padding:24px 32px;border-radius:8px 8px 0 0">',
    '<h1 style="margin:0;font-size:20px">DeepBrief AI</h1>',
    '</div>',
    '<div style="border:1px solid #e5e7eb;border-top:none;padding:32px;border-radius:0 0 8px 8px">',
    '<h2 style="color:#001A4E;margin-top:0">研究報告完成通知</h2>',
    '<p>您委託的研究主題「<strong>' + safeText + '</strong>」已完成。</p>',
    '<p>完整報告與摘要卡已附於此封信件，請查收附件。</p>',
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">',
    '<p style="color:#6b7280;font-size:13px">此信由 DeepBrief AI 自動寄出。</p>',
    '</div>',
    '</div>',
  ].join('');
}
```

- [ ] **Step 2: 驗證語法**

```bash
node --input-type=module <<'EOF'
import './server/mailer.js';
console.log('mailer.js syntax OK');
EOF
```

Expected: `mailer.js syntax OK`

---

### Task 9: 建立 server/jobRunner.js

**Files:**
- Create: `server/jobRunner.js`

- [ ] **Step 1: 建立 server/jobRunner.js**

```js
// server/jobRunner.js
import { mkdirSync } from 'fs';
import { join } from 'path';
import { updateJobStatus } from './redis.js';
import { sendReportEmail } from './mailer.js';
import { runPlanner }   from '../src/modules/planner.js';
import { runCollector } from '../src/modules/collector.js';
import { runAnalyzer }  from '../src/modules/analyzer.js';
import { runReporter }  from '../src/modules/reporter.js';
import { runReviewer }  from '../src/modules/reviewer.js';
import { runDeliverer } from '../src/modules/deliverer.js';

const BASE_TMP = process.env.TMP_DIR    || '/tmp/deepbrief';
const BASE_OUT = process.env.OUTPUT_DIR || '/tmp/deepbrief-output';

export async function runJob(jobId, topic, email) {
  const tmpDir = join(BASE_TMP, jobId);
  const outDir = join(BASE_OUT, jobId);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const opts = { force: true, tmpDir, outDir };

  await updateJobStatus(jobId, 'planning');
  const plan = await runPlanner(topic, 'standard', opts);

  await updateJobStatus(jobId, 'collecting');
  const rawSources = await runCollector(plan, opts);

  await updateJobStatus(jobId, 'analyzing');
  const analysis = await runAnalyzer(rawSources, opts);

  await updateJobStatus(jobId, 'writing');
  const report = await runReporter(plan, analysis, rawSources, opts);

  await updateJobStatus(jobId, 'reviewing');
  const reviewed = await runReviewer(report, opts);

  await updateJobStatus(jobId, 'delivering');
  const { docxPath, summaryPath } = await runDeliverer(reviewed, opts);
  await sendReportEmail({ email, topic, docxPath, summaryPath });

  await updateJobStatus(jobId, 'done');
}
```

- [ ] **Step 2: 驗證 import 鏈正確**

```bash
node --input-type=module <<'EOF'
import './server/jobRunner.js';
console.log('jobRunner.js imports OK');
EOF
```

Expected: `jobRunner.js imports OK`（無 Cannot find module）

- [ ] **Step 3: Commit**

```bash
git add server/jobRunner.js server/mailer.js
git commit -m "feat: jobRunner orchestrates full pipeline with per-job dirs; mailer sends .docx via Resend"
```

---

### Task 10: API 冒煙測試

**前提：** `.env` 中填入真實 Upstash Redis 憑證（到 upstash.com 免費建立）

- [ ] **Step 1: 啟動 server，測試輸入驗證**

```bash
node server/index.js &
sleep 2

# 空 topic → 應回 400
curl -s -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"topic":"","email":"test@example.com"}'
# Expected: {"error":"研究主題不可為空"}

# 壞 email → 應回 400
curl -s -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"topic":"測試","email":"notanemail"}'
# Expected: {"error":"Email 格式不正確"}
```

- [ ] **Step 2: 建立真實 job，確認狀態 API 可查詢**

```bash
RESP=$(curl -s -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"topic":"台積電測試","email":"your@email.com"}')
echo $RESP

JOB_ID=$(echo $RESP | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")
sleep 1
curl -s http://localhost:3000/api/jobs/$JOB_ID
# Expected: {"id":"...","status":"planning",...}
```

- [ ] **Step 3: 停止 server**

```bash
pkill -f "node server/index.js"
```

---

## Chunk 5: 前端 HTML 頁面

### Task 11: 建立共用樣式 public/style.css

**Files:**
- Create: `public/style.css`

- [ ] **Step 1: 建立 public/style.css**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --navy:  #001A4E;
  --blue:  #003087;
  --accent:#2563EB;
  --gray:  #6B7280;
  --light: #F3F4F6;
  --green: #16A34A;
  --red:   #DC2626;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--light);
  color: #111827;
  min-height: 100vh;
}

.header {
  background: var(--navy); color: #fff;
  padding: 16px 32px; display: flex; align-items: center; gap: 12px;
}
.header-logo  { font-size: 20px; font-weight: 700; }
.header-badge {
  font-size: 11px; background: rgba(255,255,255,.15);
  padding: 2px 8px; border-radius: 99px;
}

.card {
  background: #fff; border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,.1);
  padding: 40px; max-width: 520px; margin: 48px auto;
}
.card-title { font-size: 24px; font-weight: 700; color: var(--navy); margin-bottom: 8px; }
.card-sub   { color: var(--gray); margin-bottom: 32px; font-size: 15px; }

label { display: block; font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 6px; }
input[type="text"], input[type="email"] {
  width: 100%; padding: 10px 14px; font-size: 15px;
  border: 1.5px solid #D1D5DB; border-radius: 8px; outline: none;
  transition: border-color .15s;
}
input:focus { border-color: var(--accent); }
.form-group { margin-bottom: 20px; }

.btn {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%; padding: 12px 24px; border-radius: 8px;
  font-size: 15px; font-weight: 600; border: none; cursor: pointer;
  transition: opacity .15s;
}
.btn-primary   { background: var(--navy); color: #fff; }
.btn-primary:hover { opacity: .88; }
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.btn-secondary { background: var(--light); color: var(--navy); margin-top: 12px; }

.hint { font-size: 13px; color: var(--gray); margin-top: 16px; text-align: center; }

.steps    { list-style: none; margin: 24px 0; }
.step {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 0; border-bottom: 1px solid #F3F4F6;
  font-size: 15px; color: var(--gray);
}
.step:last-child { border-bottom: none; }
.step.done   { color: #111827; }
.step.active { color: var(--navy); font-weight: 600; }

.step-icon {
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; flex-shrink: 0;
}
.step.done    .step-icon { background: #DCFCE7; color: var(--green); }
.step.active  .step-icon { background: #DBEAFE; color: var(--accent); }
.step.pending .step-icon { background: #F3F4F6; color: #D1D5DB; }

@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
.step.active .step-icon { animation: pulse 1.5s ease-in-out infinite; }

.banner {
  border-radius: 8px; padding: 16px 20px; margin-bottom: 20px;
  display: flex; align-items: flex-start; gap: 12px;
}
.banner-success { background: #F0FDF4; border: 1px solid #86EFAC; }
.banner-error   { background: #FEF2F2; border: 1px solid #FCA5A5; }
.banner-title   { font-weight: 600; font-size: 15px; }
.banner-body    { font-size: 14px; color: var(--gray); margin-top: 4px; }
```

- [ ] **Step 2: Commit**

```bash
git add public/style.css
git commit -m "feat: shared CSS for DeepBrief web portal"
```

---

### Task 12: 建立表單頁 public/index.html

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: 建立 public/index.html**

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepBrief AI — 深度商業研究引擎</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="header">
  <span class="header-logo">DeepBrief AI</span>
  <span class="header-badge">內部工具</span>
</header>

<main>
  <div class="card">
    <h1 class="card-title">深度商業研究引擎</h1>
    <p class="card-sub">輸入研究主題與 Email，30 分鐘內收到機構等級報告</p>

    <form id="research-form">
      <div class="form-group">
        <label for="topic">研究主題</label>
        <input type="text" id="topic" name="topic"
          placeholder="例：台積電 2026 競爭格局分析"
          maxlength="100" required>
      </div>
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" name="email"
          placeholder="your@company.com" required>
      </div>
      <button type="submit" class="btn btn-primary" id="submit-btn">
        開始研究 →
      </button>
    </form>

    <p class="hint">預計完成時間：15–30 分鐘 · 報告以 Email 附件寄送</p>
  </div>
</main>

<script src="/config.js"></script>
<script>
  const form = document.getElementById('research-form');
  const btn  = document.getElementById('submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = '提交中…';

    const topic = document.getElementById('topic').value.trim();
    const email = document.getElementById('email').value.trim();

    try {
      const res  = await fetch(window.API_URL + '/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, email }),
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || '提交失敗，請稍後再試');
        btn.disabled = false;
        btn.textContent = '開始研究 →';
        return;
      }

      const params = new URLSearchParams({
        id:    data.jobId,
        topic: topic,
        email: email,
      });
      window.location.href = '/status?' + params.toString();
    } catch {
      alert('無法連線至伺服器，請確認網路後再試');
      btn.disabled = false;
      btn.textContent = '開始研究 →';
    }
  });
</script>
</body>
</html>
```

- [ ] **Step 2: 本機預覽**

```bash
cd public && python3 -m http.server 5500 &
```

開啟 `http://localhost:5500`，確認表單版面正確、header 深藍色。

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: research submission form page"
```

---

### Task 13: 建立進度追蹤頁 public/status/index.html

**Files:**
- Create: `public/status/index.html`

進度頁使用 `createElement` + `textContent` 操作 DOM，不使用 `innerHTML`，避免 XSS 風險。

- [ ] **Step 1: 建立 public/status/index.html**

```html
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>研究進度 — DeepBrief AI</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="header">
  <span class="header-logo">DeepBrief AI</span>
  <span class="header-badge">內部工具</span>
</header>

<main>
  <div class="card">
    <div style="margin-bottom:24px">
      <p style="font-size:13px;color:var(--gray);margin-bottom:4px">正在研究</p>
      <h2 id="topic-text" style="font-size:20px;color:var(--navy)">載入中…</h2>
    </div>

    <div id="success-banner" class="banner banner-success" style="display:none" role="status">
      <span style="font-size:24px" aria-hidden="true">✅</span>
      <div>
        <div class="banner-title">報告已寄出！</div>
        <div id="success-msg" class="banner-body"></div>
      </div>
    </div>

    <div id="error-banner" class="banner banner-error" style="display:none" role="alert">
      <span style="font-size:24px" aria-hidden="true">❌</span>
      <div>
        <div class="banner-title">研究任務失敗</div>
        <div id="error-msg" class="banner-body"></div>
      </div>
    </div>

    <ul class="steps" id="steps-list" aria-live="polite"></ul>

    <p id="email-hint" class="hint"></p>

    <button id="retry-btn" class="btn btn-secondary" style="display:none">
      再做一份研究
    </button>
  </div>
</main>

<script src="/config.js"></script>
<script>
const STEPS = [
  { key: 'planning',   label: '規劃研究架構' },
  { key: 'collecting', label: '蒐集多源資料' },
  { key: 'analyzing',  label: '分析合成資料' },
  { key: 'writing',    label: '撰寫研究報告' },
  { key: 'reviewing',  label: '品質審稿' },
  { key: 'delivering', label: '寄送報告' },
];

const ORDER = STEPS.map(s => s.key).concat(['done']);

// 使用 DOM API 安全渲染步驟列表（無 innerHTML）
function renderSteps(currentStatus) {
  const list   = document.getElementById('steps-list');
  const curIdx = ORDER.indexOf(currentStatus);
  list.textContent = ''; // 清空（比 innerHTML='' 更安全）

  STEPS.forEach((step, i) => {
    const isDone   = (i < curIdx) || currentStatus === 'done';
    const isActive = (i === curIdx) && currentStatus !== 'done' && currentStatus !== 'error';

    const li   = document.createElement('li');
    li.className = 'step ' + (isDone ? 'done' : isActive ? 'active' : 'pending');

    const icon = document.createElement('span');
    icon.className  = 'step-icon';
    icon.textContent = isDone ? '✓' : isActive ? '◉' : '○';

    const label = document.createElement('span');
    label.textContent = step.label;

    li.appendChild(icon);
    li.appendChild(label);
    list.appendChild(li);
  });
}

function showSuccess(email) {
  document.getElementById('success-banner').style.display = 'flex';
  document.getElementById('success-msg').textContent =
    '請查收 ' + email + ' 的信件，報告已作為附件寄出。';
  document.getElementById('retry-btn').style.display = 'block';
  document.getElementById('email-hint').style.display = 'none';
}

function showError(message) {
  document.getElementById('error-banner').style.display = 'flex';
  document.getElementById('error-msg').textContent = message || '未知錯誤，請重新提交';
  document.getElementById('retry-btn').style.display = 'block';
  document.getElementById('email-hint').style.display = 'none';
}

async function poll(jobId, email) {
  try {
    const res = await fetch(window.API_URL + '/api/jobs/' + jobId);
    const job = await res.json();

    renderSteps(job.status);

    if (job.status === 'done')  { showSuccess(email); return; }
    if (job.status === 'error') { showError(job.error_message); return; }

    setTimeout(() => poll(jobId, email), 3000);
  } catch {
    setTimeout(() => poll(jobId, email), 5000); // 網路錯誤 5 秒後重試
  }
}

// 初始化
const params = new URLSearchParams(location.search);
const jobId  = params.get('id');
const topic  = params.get('topic') || '';
const email  = params.get('email') || '';

if (!jobId) {
  window.location.href = '/';
} else {
  document.getElementById('topic-text').textContent = topic;
  document.getElementById('email-hint').textContent =
    '報告完成後將寄至 ' + email;

  document.getElementById('retry-btn').addEventListener('click', () => {
    window.location.href = '/';
  });

  renderSteps('queued');
  poll(jobId, email);
}
</script>
</body>
</html>
```

- [ ] **Step 2: 本機預覽**

開啟 `http://localhost:5500/status/?id=test&topic=台積電&email=test@co.com`，確認：
- 6 個步驟全部呈灰色「○ 待執行」
- 頂部顯示「正在研究 台積電」
- email hint 正確顯示

- [ ] **Step 3: Commit**

```bash
git add public/status/index.html
git commit -m "feat: status tracking page with DOM-safe step rendering and polling"
```

---

## Chunk 6: 部署

### Task 14: 先部署前端至 Vercel，取得正式 URL

- [ ] **Step 1: 在 Vercel 匯入 GitHub repo，部署（vercel.json 已配置，無需額外設定）**

- [ ] **Step 2: 記下 Vercel 部署 URL（如 `https://deepbrief.vercel.app`）**

---

### Task 15: 部署後端至 Railway

- [ ] **Step 1: 在 Railway 建立新專案，連結 GitHub repo**

- [ ] **Step 2: 在 Railway Variables 填入所有環境變數（ALLOWED_ORIGIN 填入步驟 14 取得的 Vercel URL）**

```
ANTHROPIC_API_KEY=sk-ant-...
FIRECRAWL_API_KEY=fc-...
RESEND_API_KEY=re-...
RESEND_FROM=DeepBrief AI <research@yourdomain.com>
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
CLAUDE_MODEL=claude-sonnet-4-6
MAX_SOURCES_PER_QUESTION=3
MAX_REVIEW_ITERATIONS=2
REVIEW_PASS_THRESHOLD=7.5
TMP_DIR=/tmp/deepbrief
OUTPUT_DIR=/tmp/deepbrief-output
LOG_LEVEL=info
PORT=3000
ALLOWED_ORIGIN=https://deepbrief.vercel.app
```

⚠️ **部署順序很重要**：先完成 Task 15（部署 Vercel 並取得正式 URL），再啟動 Railway。這樣 `ALLOWED_ORIGIN` 就能直接填入正確 URL，避免使用萬用字元 `*`。

- [ ] **Step 3: 確認 Railway 部署成功並取得服務 URL**

```bash
curl https://YOUR-RAILWAY-URL.railway.app/health
```

Expected: `{"ok":true}`

---

### Task 16: 更新 config.js 填入 Railway URL，推送後觸發 Vercel 重新部署

- [ ] **Step 1: 更新 public/config.js，填入 Railway URL**

```js
window.API_URL = 'https://YOUR-RAILWAY-URL.railway.app';
```

- [ ] **Step 2: Commit & push（Vercel 會自動重新部署）**

```bash
git add public/config.js
git commit -m "config: set Railway API URL for production"
git push
```

---

### Task 17: 端對端驗收

- [ ] **Step 1: 開啟 Vercel URL，填入「台積電 2026 競爭格局」與自己的 Email，送出**

- [ ] **Step 2: 確認進度頁每 3 秒更新，各階段依序點亮**

- [ ] **Step 3: 等待 15-30 分鐘，確認 Email 收到含 .docx 附件**

- [ ] **Step 4: 打開 .docx，確認中文正常、報告字數 ≥ 3000 字**

- [ ] **Step 5: 驗收清單**

```
[ ] Vercel URL 可開啟，表單正常運作
[ ] 進度頁顯示各階段依序更新
[ ] Email 收到含 .docx 附件的信件
[ ] .docx 可正常開啟，中文顯示正確
[ ] 出錯時進度頁顯示錯誤訊息（非白屏）
[ ] Railway 重啟後孤立 job 標記為 error
```
