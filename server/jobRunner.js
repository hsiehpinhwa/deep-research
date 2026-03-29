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
