import { callClaudeJSON } from '../utils/claude.js';
import { saveTmp, loadTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import { PLANNER_SYSTEM, buildPlannerPrompt } from '../prompts/planner.prompt.js';

export async function runPlanner(topic, depth = 'standard', options = {}) {
  const tmpDir = options.tmpDir;
  const cacheKey = 'research_plan.json';

  // 允許跳過快取直接重新規劃
  if (!options.force) {
    const cached = loadTmp(cacheKey, tmpDir);
    if (cached && cached.topic === topic) {
      logger.info('PLANNER', `使用快取的研究計畫：${topic}`);
      return cached;
    }
  }

  logger.step('PLANNER', `開始規劃研究：${topic}`);

  const plan = await callClaudeJSON(
    PLANNER_SYSTEM,
    buildPlannerPrompt(topic, depth),
    { maxTokens: 8192 }
  );

  plan.generated_at = new Date().toISOString();
  plan.topic = topic;

  const path = saveTmp(cacheKey, plan, tmpDir);
  logger.info('PLANNER', `研究計畫已儲存：${path}（${plan.sub_questions?.length} 個子問題）`);

  return plan;
}

// CLI 直接執行
if (process.argv[1]?.endsWith('planner.js')) {
  const { program } = await import('commander');
  program
    .option('--topic <topic>', '研究主題')
    .option('--depth <depth>', '研究深度 (standard|deep)', 'standard')
    .option('--force', '強制重新規劃（忽略快取）')
    .parse();

  const opts = program.opts();
  if (!opts.topic) {
    console.error('請提供 --topic 參數');
    process.exit(1);
  }

  const plan = await runPlanner(opts.topic, opts.depth, { force: opts.force });
  console.log('\n=== 研究計畫概覽 ===');
  console.log(`主題：${plan.topic}`);
  console.log(`類型：${plan.report_type}`);
  console.log(`子問題：${plan.sub_questions?.length} 個`);
  plan.sub_questions?.forEach(q => {
    console.log(`  [${q.id}] P${q.priority} ${q.question}`);
  });
}
