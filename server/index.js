// server/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { createReadStream, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createJob, getJob, updateJobStatus, getActiveJobs } from './redis.js';
import { runJob } from './jobRunner.js';

import { BASE_OUT } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 3000;
// Support comma-separated origins: "https://dorphinai.com,https://dorphinai.vercel.app"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5500')
  .split(',').map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(null, false);
  }
}));
app.use(express.json());

// Serve static frontend files from public/
app.use(express.static(join(__dirname, '..', 'public')));

// POST /api/jobs — create research job
app.post('/api/jobs', async (req, res) => {
  const { topic, email } = req.body || {};

  if (!topic?.trim())
    return res.status(400).json({ error: '研究主題不可為空' });
  if (!email?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
    return res.status(400).json({ error: 'Email 格式不正確' });

  const jobId = uuidv4();
  await createJob(jobId, topic.trim(), email.trim());

  // Fire and forget — don't await
  runJob(jobId, topic.trim(), email.trim()).catch(async (err) => {
    await updateJobStatus(jobId, 'error', { error_message: err.message });
  });

  res.status(201).json({ jobId });
});

// GET /api/jobs/:id — query job status
app.get('/api/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '找不到此任務' });
  res.json(job);
});

// GET /api/jobs/:id/files — list downloadable files for a completed job
app.get('/api/jobs/:id/files', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '找不到此任務' });
  if (job.status !== 'done') return res.json({ files: [] });

  const outDir = join(BASE_OUT, req.params.id);
  if (!existsSync(outDir)) return res.json({ files: [] });

  const files = readdirSync(outDir)
    .filter(f => f.endsWith('.docx') || f.endsWith('.md'))
    .map(f => ({ name: f, url: `/api/jobs/${req.params.id}/download/${encodeURIComponent(f)}` }));

  res.json({ files });
});

// GET /api/jobs/:id/download/:filename — stream file download
app.get('/api/jobs/:id/download/:filename', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '找不到此任務' });

  const filename = basename(decodeURIComponent(req.params.filename)); // prevent path traversal
  const filePath = join(BASE_OUT, req.params.id, filename);
  if (!existsSync(filePath)) return res.status(404).json({ error: '檔案不存在' });

  const contentType = filename.endsWith('.docx')
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'text/markdown; charset=utf-8';
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', contentType);
  createReadStream(filePath).pipe(res);
});

// GET /health/search — diagnose search engine availability
app.get('/health/search', async (req, res) => {
  const dns = await import('dns');
  const { default: config } = await import('../src/config.js');

  // 1. Key status
  const keys = {
    FIRECRAWL_API_KEY: config.firecrawl.apiKey ? `set (${config.firecrawl.apiKey.slice(0, 6)}...)` : 'NOT SET',
    BRAVE_SEARCH_API_KEY: config.brave?.apiKey ? `set (${config.brave.apiKey.slice(0, 6)}...)` : 'NOT SET',
    GOOGLE_CSE_API_KEY: config.google?.cseApiKey ? `set (${config.google.cseApiKey.slice(0, 6)}...)` : 'NOT SET',
    GOOGLE_CSE_CX: config.google?.cseCx ? `set (${config.google.cseCx.slice(0, 6)}...)` : 'NOT SET',
    EXA_API_KEY: config.exa?.apiKey ? `set (${config.exa.apiKey.slice(0, 6)}...)` : 'NOT SET',
  };

  // 2. DNS resolution
  const hosts = [
    { name: 'Firecrawl', host: 'api.firecrawl.dev' },
    { name: 'Brave', host: 'api.search.brave.com' },
    { name: 'Google', host: 'www.googleapis.com' },
    { name: 'Exa', host: 'api.exa.ai' },
  ];

  const dnsResults = {};
  for (const { name, host } of hosts) {
    const start = Date.now();
    try {
      await dns.promises.lookup(host);
      dnsResults[name] = { status: 'ok', host, latency: Date.now() - start + 'ms' };
    } catch (err) {
      dnsResults[name] = { status: 'FAILED', host, error: err.code || err.message };
    }
  }

  // 3. Live search test (only when ?run=true)
  let tests = null;
  if (req.query.run === 'true') {
    const axios = (await import('axios')).default;
    tests = {};

    // Test Brave
    if (config.brave?.apiKey) {
      const start = Date.now();
      try {
        const r = await axios.get('https://api.search.brave.com/res/v1/web/search', {
          params: { q: 'test', count: 1 },
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': config.brave.apiKey },
          timeout: 10000,
        });
        tests.brave = { ok: true, count: r.data?.web?.results?.length || 0, latency: Date.now() - start + 'ms' };
      } catch (err) {
        tests.brave = { ok: false, error: err.code || err.message, status: err.response?.status, latency: Date.now() - start + 'ms' };
      }
    }

    // Test Google CSE
    if (config.google?.cseApiKey && config.google?.cseCx) {
      const start = Date.now();
      try {
        const r = await axios.get('https://www.googleapis.com/customsearch/v1', {
          params: { key: config.google.cseApiKey, cx: config.google.cseCx, q: 'test', num: 1 },
          timeout: 10000,
        });
        tests.google = { ok: true, count: r.data?.items?.length || 0, latency: Date.now() - start + 'ms' };
      } catch (err) {
        tests.google = { ok: false, error: err.code || err.message, status: err.response?.status, latency: Date.now() - start + 'ms' };
      }
    }

    // Test Exa
    if (config.exa?.apiKey) {
      const start = Date.now();
      try {
        const r = await axios.post('https://api.exa.ai/search',
          { query: 'test', numResults: 1, type: 'neural' },
          { headers: { 'x-api-key': config.exa.apiKey, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        tests.exa = { ok: true, count: r.data?.results?.length || 0, latency: Date.now() - start + 'ms' };
      } catch (err) {
        tests.exa = { ok: false, error: err.code || err.message, status: err.response?.status, latency: Date.now() - start + 'ms' };
      }
    }

    // Test Firecrawl
    if (config.firecrawl.apiKey) {
      const start = Date.now();
      try {
        const r = await axios.post('https://api.firecrawl.dev/v1/search',
          { query: 'test', limit: 1 },
          { headers: { Authorization: `Bearer ${config.firecrawl.apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        tests.firecrawl = { ok: true, count: r.data?.data?.length || 0, latency: Date.now() - start + 'ms' };
      } catch (err) {
        tests.firecrawl = { ok: false, error: err.code || err.message, status: err.response?.status, latency: Date.now() - start + 'ms' };
      }
    }

    // Test free scrape (outbound HTTP)
    {
      const start = Date.now();
      try {
        await axios.get('https://www.google.com', { timeout: 5000, maxRedirects: 1 });
        tests.outbound_http = { ok: true, latency: Date.now() - start + 'ms' };
      } catch (err) {
        tests.outbound_http = { ok: false, error: err.code || err.message, latency: Date.now() - start + 'ms' };
      }
    }
  }

  res.json({
    timestamp: new Date().toISOString(),
    node_env: process.env.NODE_ENV || 'not set',
    railway: !!process.env.RAILWAY_ENVIRONMENT,
    keys,
    dns: dnsResults,
    ...(tests ? { tests } : { hint: 'Add ?run=true to test actual search requests' }),
  });
});

// GET /health — health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Clean up stale jobs on startup (jobs stuck in active state from prior crash)
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

// Run cleanup BEFORE accepting requests to avoid race condition
// Wrap with a 5s timeout so a hung Redis connection doesn't block server startup
const cleanup = Promise.race([
  cleanupStaleJobs(),
  new Promise(resolve => setTimeout(resolve, 5000)),
]);
cleanup.then(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] Dolphin.Ai API 啟動於 port ${PORT}`);
  });
});