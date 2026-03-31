import { callClaudeJSON } from '../utils/claude.js';
import { saveTmp, loadTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import { ANALYZER_SYSTEM, COMPANY_ANALYZER_SYSTEM, buildAnalyzerPrompt } from '../prompts/analyzer.prompt.js';

/**
 * 分析單一子問題的所有來源
 * @param {string} systemPrompt - the analyzer system prompt to use
 */
async function analyzeQuestion(questionData, systemPrompt) {
  if (!questionData.sources || questionData.sources.length === 0) {
    logger.warn('ANALYZER', `[${questionData.question_id}] 無來源資料，跳過`);
    return {
      question_id: questionData.question_id,
      question: questionData.question,
      synthesis: {
        consensus: [],
        divergence: [],
        key_insights: [],
        data_points: [],
        gaps: ['缺乏來源資料，無法分析'],
      },
    };
  }

  logger.step('ANALYZER', `[${questionData.question_id}] 分析 ${questionData.sources.length} 個來源`);

  const result = await callClaudeJSON(
    systemPrompt,
    buildAnalyzerPrompt(questionData),
    { maxTokens: 8192 }
  );

  result.question_id = questionData.question_id;
  result.question = questionData.question;

  const insightCount = result.synthesis?.key_insights?.length || 0;
  logger.info('ANALYZER', `[${questionData.question_id}] 完成，${insightCount} 個洞見`);

  return result;
}

/**
 * 主函式：分析所有子問題
 * @param {Array} rawSources - collected sources per question
 * @param {object} options - { force, tmpDir, research_mode }
 */
export async function runAnalyzer(rawSources, options = {}) {
  const tmpDir = options.tmpDir;
  const cacheKey = 'analysis.json';

  if (!options.force) {
    const cached = loadTmp(cacheKey, tmpDir);
    if (cached) {
      logger.info('ANALYZER', `使用快取的分析結果（${cached.length} 個子問題）`);
      return cached;
    }
  }

  // Pick system prompt based on research mode
  const isCompany = options.research_mode === 'company';
  const systemPrompt = isCompany ? COMPANY_ANALYZER_SYSTEM : ANALYZER_SYSTEM;

  if (isCompany) {
    logger.step('ANALYZER', '使用企業研究分析框架（波特五力 / SWOT / 財報解讀）');
  }

  const results = [];

  // 批次並行（每次 3 個 Claude call，加速分析階段）
  const BATCH_SIZE = 3;
  for (let i = 0; i < rawSources.length; i += BATCH_SIZE) {
    const batch = rawSources.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(qd => analyzeQuestion(qd, systemPrompt))
    );
    results.push(...batchResults);
  }

  const path = saveTmp(cacheKey, results, tmpDir);
  logger.info('ANALYZER', `分析完成，已儲存至 ${path}`);

  return results;
}

// CLI 直接執行
if (process.argv[1]?.endsWith('analyzer.js')) {
  const rawSources = loadTmp('raw_sources.json');
  if (!rawSources) {
    console.error('找不到 tmp/raw_sources.json，請先執行 collector');
    process.exit(1);
  }
  await runAnalyzer(rawSources, { force: true });
}
