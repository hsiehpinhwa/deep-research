// server/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { createReadStream, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { createJob, getJob, updateJobStatus, getActiveJobs } from './redis.js';
import { runJob } from './jobRunner.js';

import { BASE_OUT } from './config.js';

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