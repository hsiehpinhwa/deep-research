import { callClaudeJSON } from '../utils/claude.js';
import { saveTmp, loadTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import { runAnalyzer } from './analyzer.js';
import { collectForQuestion } from './collector.js';
import { GAP_FILL_SYSTEM, buildGapFillPrompt } from '../prompts/gapFill.prompt.js';

/**
 * Extract all gaps from first-round analysis.
 */
function extractGaps(analysis) {
  const gaps = [];
  for (const a of analysis) {
    for (const g of a.synthesis?.gaps || []) {
      if (g && !g.includes('（無）')) gaps.push(g);
    }
  }
  return [...new Set(gaps)]; // dedupe
}

/**
 * Convert gap descriptions into searchable questions via Claude.
 */
async function gapsToQuestions(gaps, planContext) {
  const result = await callClaudeJSON(
    GAP_FILL_SYSTEM,
    buildGapFillPrompt(gaps, planContext),
    { maxTokens: 4096 }
  );
  // Ensure it's an array
  return Array.isArray(result) ? result : [];
}

/**
 * Merge new sources into existing rawSources, deduplicating by URL.
 */
function mergeSources(original, additional) {
  const merged = JSON.parse(JSON.stringify(original)); // deep clone
  const seenUrls = new Set();

  // Index existing URLs
  for (const q of merged) {
    for (const s of q.sources || []) {
      seenUrls.add(s.url);
    }
  }

  // Add new sources as additional question entries (preserve references)
  for (const q of additional) {
    const newSources = (q.sources || []).filter(s => !seenUrls.has(s.url));
    if (newSources.length > 0) {
      merged.push({
        question_id: q.question_id,
        question: q.question,
        sources: newSources,
        references: q.references || [],
      });
      for (const s of newSources) seenUrls.add(s.url);
    }
  }

  return merged;
}

/**
 * Main gap-fill function.
 * Runs after first-round analysis to fill data gaps with a second collection round.
 *
 * @param {object} plan - research plan from planner
 * @param {Array} rawSources - first-round collected sources
 * @param {Array} analysis - first-round analysis results
 * @param {object} options - { tmpDir, force, research_mode }
 * @returns {{ mergedSources: Array, finalAnalysis: Array }}
 */
export async function runGapFill(plan, rawSources, analysis, options = {}) {
  const tmpDir = options.tmpDir;

  try {
    return await _runGapFillInternal(plan, rawSources, analysis, options);
  } catch (err) {
    // Gap-fill is enhancement, not critical — don't let it kill the pipeline
    logger.warn('GAP-FILL', `缺口補充失敗（${err.message}），使用第一輪結果繼續`);
    return { mergedSources: rawSources, finalAnalysis: analysis };
  }
}

async function _runGapFillInternal(plan, rawSources, analysis, options) {
  const tmpDir = options.tmpDir;

  // Step 1: Extract gaps
  const gaps = extractGaps(analysis);
  logger.step('GAP-FILL', `第一輪分析發現 ${gaps.length} 個資料缺口`);

  if (gaps.length < 2) {
    logger.info('GAP-FILL', '缺口不足 2 個，跳過第二輪蒐集');
    return { mergedSources: rawSources, finalAnalysis: analysis };
  }

  // Log gaps for debugging
  for (const g of gaps.slice(0, 5)) {
    logger.info('GAP-FILL', `  缺口: ${g.slice(0, 60)}...`);
  }

  // Step 2: Convert gaps to search questions
  logger.step('GAP-FILL', '將缺口轉換為搜尋關鍵字...');
  const planContext = {
    topic: plan.topic,
    company_name: plan.company_name,
    ticker: plan.ticker,
    market: plan.market,
  };
  const gapQuestions = await gapsToQuestions(gaps.slice(0, 6), planContext); // max 6 gaps
  logger.info('GAP-FILL', `生成 ${gapQuestions.length} 個補充搜尋問題`);

  if (gapQuestions.length === 0) {
    logger.warn('GAP-FILL', '無法生成搜尋問題，跳過');
    return { mergedSources: rawSources, finalAnalysis: analysis };
  }

  // Step 3: Run second-round collection
  logger.step('GAP-FILL', '開始第二輪資料蒐集...');
  const planMeta = {
    research_mode: plan.research_mode || 'market',
    market: plan.market || 'general',
  };
  const maxSources = 3; // fewer per gap question

  const secondRoundResults = [];
  for (const gq of gapQuestions) {
    const question = {
      id: gq.id || `gap_${secondRoundResults.length + 1}`,
      question: gq.question || gq.gap_description,
      search_keywords: gq.search_keywords,
    };
    const result = await collectForQuestion(question, maxSources, planMeta);
    secondRoundResults.push(result);
    logger.info('GAP-FILL', `  [${question.id}] 取得 ${result.sources.length} 個新來源`);
  }

  const newSourceCount = secondRoundResults.reduce((sum, r) => sum + r.sources.length, 0);
  logger.step('GAP-FILL', `第二輪蒐集完成：${newSourceCount} 個新來源`);

  if (newSourceCount === 0) {
    logger.warn('GAP-FILL', '第二輪無新來源，使用第一輪結果');
    return { mergedSources: rawSources, finalAnalysis: analysis };
  }

  // Step 4: Merge sources
  const mergedSources = mergeSources(rawSources, secondRoundResults);
  saveTmp('raw_sources_merged.json', mergedSources, tmpDir);
  logger.info('GAP-FILL', `合併後共 ${mergedSources.length} 組來源`);

  // Step 5: Re-run analyzer on merged sources
  logger.step('GAP-FILL', '以合併資料重新分析...');
  const analyzerOpts = { ...options, force: true, research_mode: plan.research_mode };
  const finalAnalysis = await runAnalyzer(mergedSources, analyzerOpts);

  saveTmp('analysis_final.json', finalAnalysis, tmpDir);
  logger.step('GAP-FILL', '缺口補充完成');

  return { mergedSources, finalAnalysis };
}
