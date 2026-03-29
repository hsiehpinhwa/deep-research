// server/jobRunner.js
import { mkdirSync } from 'fs';
import { join } from 'path';
import { BASE_TMP, BASE_OUT } from './config.js';
import { updateJobStatus } from './redis.js';
import { sendReportEmail } from './mailer.js';
import { runPlanner }   from '../src/modules/planner.js';
import { runCollector } from '../src/modules/collector.js';
import { runAnalyzer }  from '../src/modules/analyzer.js';
import { runReporter }  from '../src/modules/reporter.js';
import { runReviewer }  from '../src/modules/reviewer.js';
import { runDeliverer } from '../src/modules/deliverer.js';

export async function runJob(jobId, topic, email) {
  const tmpDir = join(BASE_TMP, jobId);
  const outDir = join(BASE_OUT, jobId);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const opts = { force: true, tmpDir, outDir };

  // Wraps each pipeline stage: sets status, and annotates any thrown error
  // with the stage name so error_message in Redis is always diagnosable.
  async function stage(name, fn) {
    await updateJobStatus(jobId, name);
    try {
      return await fn();
    } catch (err) {
      err.message = `[${name}] ${err.message}`;
      throw err;
    }
  }

  const plan       = await stage('planning',   () => runPlanner(topic, 'standard', opts));
  const rawSources = await stage('collecting', () => runCollector(plan, opts));

  // Pass research_mode from planner to analyzer so it picks the right framework
  const analyzerOpts = { ...opts, research_mode: plan.research_mode };
  const analysis   = await stage('analyzing',  () => runAnalyzer(rawSources, analyzerOpts));
  const report     = await stage('writing',    () => runReporter(plan, analysis, rawSources, opts));
  const reviewed   = await stage('reviewing',  () => runReviewer(report, opts));
  const { docxPath, summaryPath } = await stage('delivering', () => runDeliverer(reviewed, opts));

  console.log(`[JOB ${jobId}] docxPath=${docxPath}, summaryPath=${summaryPath}`);

  const emailResult = await sendReportEmail({ email, topic, docxPath, summaryPath });
  if (emailResult?.error) {
    const errMsg = emailResult.error.message || JSON.stringify(emailResult.error);
    console.error(`[JOB ${jobId}] Email 寄送失敗:`, errMsg);
    await updateJobStatus(jobId, 'done', { email_error: errMsg });
  } else {
    console.log(`[JOB ${jobId}] Email 已寄出至 ${email}`);
    await updateJobStatus(jobId, 'done', { email_sent: 'true' });
  }
}
