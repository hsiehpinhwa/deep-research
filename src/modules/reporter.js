import { callClaudeJSON, callClaude } from '../utils/claude.js';
import { saveTmp, loadTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import { REPORTER_SYSTEM, buildReporterPrompt, buildSectionPrompt } from '../prompts/reporter.prompt.js';

/**
 * 從 raw_sources + analysis 萃取完整去重來源清單
 * 三層來源：
 *   1. rawSources[].sources — collector 蒐集且內容充足的來源
 *   2. rawSources[].references — 搜尋到但內容不足的 URL
 *   3. analysis[].synthesis.data_points[].source_url — analyzer 實際引用的 URL
 */
function extractSources(rawSources, analysis) {
  const seen = new Set();
  const sources = [];

  function addSource(url, title, domain, fetchedAt) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    let d = domain;
    if (!d) {
      try { d = new URL(url).hostname; } catch { d = ''; }
    }
    sources.push({ title: title || d, url, domain: d, fetched_at: fetchedAt });
  }

  // Layer 1: collector 的主要來源
  for (const q of rawSources || []) {
    for (const s of q.sources || []) {
      addSource(s.url, s.title || s.domain, s.domain, s.fetched_at);
    }
    // Layer 2: 搜尋到但內容不足的 URL
    for (const r of q.references || []) {
      addSource(r.url, r.title || r.domain, r.domain, r.fetched_at);
    }
  }

  // Layer 3: analyzer 的 data_points 中實際引用的 source_url
  for (const a of analysis || []) {
    const dps = a.synthesis?.data_points || [];
    for (const dp of dps) {
      const url = typeof dp === 'object' ? dp.source_url : null;
      if (url && url !== '未標明') {
        // 從 data_point 的 claim 擷取更好的標題
        const claim = typeof dp === 'object' ? dp.claim : '';
        const title = claim ? claim.slice(0, 50) : '';
        addSource(url, title, null, null);
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
 * Extract key data claims from section text for dedup tracking.
 * Looks for patterns like numbers with units, percentages, currency amounts.
 */
function extractClaimsFromText(text) {
  const claims = [];
  // Match numbers with units: "494億", "25%", "USD 249億", "1,500萬", etc.
  const patterns = [
    /[\d,]+\.?\d*\s*[億萬千百][\w元幣]*(?:\s*[\(（][^)）]*[\)）])?/g,
    /\d+\.?\d*\s*%/g,
    /(?:USD|HKD|NTD|TWD|RMB|港幣|美元|新台幣)\s*[\d,]+\.?\d*\s*[億萬千百]?/g,
    /CAGR\s*[\d.]+%/g,
    /(?:年增|成長|下滑|衰退)\s*[\d.]+%/g,
  ];
  for (const pat of patterns) {
    const matches = text.match(pat);
    if (matches) claims.push(...matches);
  }
  return [...new Set(claims)]; // deduplicate
}

/**
 * Parse TABLE_JSON markers from section content.
 * Returns { cleanContent, tables[] }
 */
function parseTablesFromContent(text) {
  const tables = [];
  const cleanContent = text.replace(
    /\[TABLE_JSON\]([\s\S]*?)\[\/TABLE_JSON\]/g,
    (_, json) => {
      try {
        const table = JSON.parse(json.trim());
        if (table.headers && table.rows) tables.push(table);
      } catch { /* ignore malformed */ }
      return ''; // remove from text
    }
  ).trim();
  return { cleanContent, tables };
}

/**
 * 生成單一章節正文
 * @param {Array<string>} previousClaims - data claims used in earlier sections (for dedup)
 */
async function generateSection(sectionDef, plan, analysis, previousClaims = []) {
  const text = await callClaude(
    REPORTER_SYSTEM,
    buildSectionPrompt(sectionDef, plan, analysis, previousClaims),
    { maxTokens: 8192 }
  );

  const { cleanContent, tables } = parseTablesFromContent(text.trim());

  return {
    id: sectionDef.id,
    title: sectionDef.title,
    content: cleanContent,
    tables,
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
  const allPreviousClaims = []; // cumulative dedup tracker

  for (const sectionDef of sections) {
    logger.step('REPORTER', `  生成：${sectionDef.title}（已用 ${allPreviousClaims.length} 個數據點）`);
    const fullSection = await generateSection(sectionDef, plan, analysis, allPreviousClaims);
    fullSections.push(fullSection);

    // Extract claims from this section and add to tracker
    const newClaims = extractClaimsFromText(fullSection.content);
    allPreviousClaims.push(...newClaims);
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

  // 注入真實來源（三層：collector sources + references + analyzer data_points）
  const effectiveRawSources = rawSources || loadTmp('raw_sources.json', tmpDir) || [];
  const sources = extractSources(effectiveRawSources, analysis);
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
