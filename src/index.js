#!/usr/bin/env node
/**
 * DeepBrief AI — 主管線協調器
 * 使用方式：node src/index.js --topic "研究主題"
 */
import './config.js';  // 觸發環境變數驗證

import { program } from 'commander';
import { logger } from './utils/logger.js';
import { runPlanner } from './modules/planner.js';
import { runCollector } from './modules/collector.js';
import { runAnalyzer } from './modules/analyzer.js';
import { runReporter } from './modules/reporter.js';
import { runReviewer } from './modules/reviewer.js';
import { runDeliverer } from './modules/deliverer.js';

program
  .name('deepbrief')
  .description('DeepBrief AI — 商業深度研究引擎')
  .option('--topic <topic>', '研究主題（必填）')
  .option('--depth <depth>', '研究深度 (standard|deep)', 'standard')
  .option('--force', '強制重新執行所有階段（忽略快取）')
  .option('--skip-review', '跳過品質審稿迴圈')
  .option('--resume-from <stage>', '從指定階段繼續 (collector|analyzer|reporter|reviewer|deliverer)')
  .parse();

const opts = program.opts();

if (!opts.topic) {
  console.error('[DeepBrief] 錯誤：請提供 --topic 參數');
  console.error('  範例：node src/index.js --topic "台灣半導體產業 2026 展望"');
  process.exit(1);
}

async function main() {
  const startTime = Date.now();
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║         DeepBrief AI 研究引擎         ║');
  console.log('╚══════════════════════════════════════╝\n');

  logger.step('PIPELINE', `研究主題：${opts.topic}`);
  logger.step('PIPELINE', `研究深度：${opts.depth}`);
  if (opts.force) logger.warn('PIPELINE', '強制模式：忽略所有快取');

  const force = opts.force || false;
  const resumeFrom = opts.resumeFrom;

  try {
    // ── 階段 1：研究規劃 ───────────────────────────────
    let plan;
    if (!resumeFrom || resumeFrom === 'planner') {
      plan = await runPlanner(opts.topic, opts.depth, { force });
    } else {
      const { loadTmp } = await import('./utils/fileUtils.js');
      plan = loadTmp('research_plan.json');
      if (!plan) throw new Error('找不到 research_plan.json，請從頭執行');
    }

    // ── 階段 2：多源蒐集 ───────────────────────────────
    let rawSources;
    const skipCollector = resumeFrom && !['collector'].includes(resumeFrom) &&
                          ['analyzer', 'reporter', 'reviewer', 'deliverer'].includes(resumeFrom);
    if (!skipCollector) {
      rawSources = await runCollector(plan, { force });
    } else {
      const { loadTmp } = await import('./utils/fileUtils.js');
      rawSources = loadTmp('raw_sources.json');
      if (!rawSources) throw new Error('找不到 raw_sources.json');
    }

    // ── 階段 3：分析合成 ───────────────────────────────
    let analysis;
    const skipAnalyzer = resumeFrom && ['reporter', 'reviewer', 'deliverer'].includes(resumeFrom);
    if (!skipAnalyzer) {
      analysis = await runAnalyzer(rawSources, { force });
    } else {
      const { loadTmp } = await import('./utils/fileUtils.js');
      analysis = loadTmp('analysis.json');
      if (!analysis) throw new Error('找不到 analysis.json');
    }

    // ── 階段 4：報告生成 ───────────────────────────────
    let reportContent;
    const skipReporter = resumeFrom && ['reviewer', 'deliverer'].includes(resumeFrom);
    if (!skipReporter) {
      reportContent = await runReporter(plan, analysis, rawSources, { force });
    } else {
      const { loadTmp } = await import('./utils/fileUtils.js');
      reportContent = loadTmp('report_content.json');
      if (!reportContent) throw new Error('找不到 report_content.json');
    }

    // ── 階段 5：品質審稿 ───────────────────────────────
    if (!opts.skipReview) {
      const skipReviewer = resumeFrom === 'deliverer';
      if (!skipReviewer) {
        reportContent = await runReviewer(reportContent);
      }
    } else {
      logger.warn('PIPELINE', '已跳過品質審稿迴圈');
    }

    // ── 階段 6：交付 ───────────────────────────────────
    const delivery = await runDeliverer(reportContent);

    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log('\n╔══════════════════════════════════════╗');
    console.log(`║  ✓ 研究完成！耗時 ${elapsed} 分鐘           ║`);
    console.log(`║  輸出目錄：output/                    ║`);
    console.log('╚══════════════════════════════════════╝\n');

  } catch (err) {
    logger.error('PIPELINE', `管線執行失敗：${err.message}`);
    if (process.env.LOG_LEVEL === 'debug') {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
