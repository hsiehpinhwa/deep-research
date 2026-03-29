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
    console.log(`[SERVER] DeepBrief API 啟動於 port ${PORT}`);
  });
});