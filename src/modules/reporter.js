import { callClaudeJSON, callClaude } from '../utils/claude.js';
import { saveTmp, loadTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import { REPORTER_SYSTEM, buildReporterPrompt, buildSectionPrompt } from '../prompts/reporter.prompt.js';

/**
 * 從 raw_sources 萃取去重來源清單
 */
function extractSources(rawSources, tmpDir) {
  const seen = new Set();
  const sources = [];
  for (const q of rawSources || []) {
    for (const s of q.sources || []) {
      if (!seen.has(s.url)) {
        seen.add(s.url);
        sources.push({
          title: s.title || s.domain,
          url: s.url,
          domain: s.domain,
          fetched_at: s.fetched_at,
        });
      }
    }
  }
  return sources;
}

/**
 * 生成報告骨架（meta + executive_summary + outline + risk + sources）
 */
async function generateReportSkeleton(plan, analysis) {
  const skeleton = await callClaudeJSON(
    REPORTER_SYSTEM,
    buildReporterPrompt(plan, analysis, 'skeleton'),
    { maxTokens: 16384 }
  );
  return skeleton;
}

/**
 * 生成單一章節正文
 */
async function generateSection(sectionDef, plan, analysis) {
  const text = await callClaude(
    REPORTER_SYSTEM,
    buildSectionPrompt(sectionDef, plan, analysis),
    { maxTokens: 8192 }
  );

  // 純文字輸出，不是 JSON
  return {
    id: sectionDef.id,
    title: sectionDef.title,
    content: text.trim(),
    key_data: sectionDef.key_data || [],
    linked_questions: sectionDef.linked_questions || [],
  };
}

/**
 * 主函式：分段生成完整報告
 */
export async function runReporter(plan, analysis, rawSources, options = {}) {
  // 支援舊呼叫方式：runReporter(plan, analysis, options)
  if (rawSources && !Array.isArray(rawSources)) {
    options = rawSources;
    rawSources = null;
  }
  const tmpDir = options.tmpDir;
  const cacheKey = 'report_content.json';

  if (!options.force) {
    const cached = loadTmp(cacheKey, tmpDir);
    if (cached) {
      logger.info('REPORTER', `使用快取的報告內容`);
      return cached;
    }
  }

  logger.step('REPORTER', `開始生成報告：${plan.topic}`);

  // Step 1：生成骨架（meta、摘要、章節清單、風險、來源）
  logger.step('REPORTER', '生成報告骨架...');
  const skeleton = await generateReportSkeleton(plan, analysis);

  // Step 2：逐章節生成正文
  const sections = skeleton.sections || [];
  logger.step('REPORTER', `逐章節生成正文（共 ${sections.length} 個章節）...`);

  const fullSections = [];
  for (const sectionDef of sections) {
    logger.step('REPORTER', `  生成：${sectionDef.title}`);
    const fullSection = await generateSection(sectionDef, plan, analysis);
    fullSections.push(fullSection);
  }

  // Step 3：組裝完整報告
  const report = {
    ...skeleton,
    sections: fullSections,
  };

  // 補充後設資料
  report.meta = report.meta || {};
  report.meta.topic = plan.topic;
  report.meta.generated_at = new Date().toISOString();
  if (!report.meta.date) {
    const now = new Date();
    report.meta.date = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  }

  // 注入真實來源（從 rawSources 萃取，或嘗試從快取載入）
  const sources = rawSources
    ? extractSources(rawSources, tmpDir)
    : extractSources(loadTmp('raw_sources.json', tmpDir) || [], tmpDir);
  report.sources = sources;
  logger.info('REPORTER', `已注入 ${sources.length} 個來源`);

  const path = saveTmp(cacheKey, report, tmpDir);
  logger.info('REPORTER', `報告已生成：${fullSections.length} 個章節，儲存至 ${path}`);

  return report;
}

// CLI 直接執行
if (process.argv[1]?.endsWith('reporter.js')) {
  const plan = loadTmp('research_plan.json');
  const analysis = loadTmp('analysis.json');
  if (!plan || !analysis) {
    console.error('找不到必要的 tmp/*.json，請先執行前置模組');
    process.exit(1);
  }
  await runReporter(plan, analysis, { force: true });
}
