import { callClaudeJSON } from '../utils/claude.js';
import { saveTmp, loadTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import { ANALYZER_SYSTEM, buildAnalyzerPrompt } from '../prompts/analyzer.prompt.js';

/**
 * 分析單一子問題的所有來源
 */
async function analyzeQuestion(questionData) {
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
    ANALYZER_SYSTEM,
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

  const results = [];

  // 逐一處理（分析較耗 token，不平行以控制成本）
  for (const questionData of rawSources) {
    const analysis = await analyzeQuestion(questionData);
    results.push(analysis);
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
