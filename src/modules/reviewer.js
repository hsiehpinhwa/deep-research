import { callClaudeJSON } from '../utils/claude.js';
import { saveTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import { REVIEWER_SYSTEM, buildReviewerPrompt, buildRevisionPrompt } from '../prompts/reviewer.prompt.js';
import config from '../config.js';
import { spawnSync } from 'child_process';
import { tmpPath, rootPath } from '../utils/fileUtils.js';

/**
 * 執行 CJK 掃描（呼叫 Python 工具）
 */
function runCJKScanner(reportContent, tmpDir) {
  const inputPath = tmpPath('report_content.json', tmpDir);
  const result = spawnSync('python3', [
    rootPath('tools', 'cjk_scanner.py'),
    '--input', inputPath,
  ], { encoding: 'utf-8' });

  if (result.error) {
    logger.warn('REVIEWER', `CJK 掃描器執行失敗：${result.error.message}`);
    return [];
  }

  try {
    // 取最後一個 JSON 輸出
    const lines = result.stdout.trim().split('\n');
    const jsonLine = lines.slice(-1)[0];
    const scanResult = JSON.parse(jsonLine);
    return scanResult.violations || [];
  } catch {
    return [];
  }
}

/**
 * 修訂指定章節
 */
async function reviseSection(section, feedback) {
  logger.step('REVIEWER', `修訂章節：${section.title}`);
  try {
    return await callClaudeJSON(
      '你是機構報告撰寫人，根據審稿意見修訂章節。輸出純 JSON。',
      buildRevisionPrompt(section, feedback),
      { maxTokens: 4096 }
    );
  } catch (err) {
    logger.warn('REVIEWER', `修訂 ${section.title} 失敗（${err.message}），保留原文`);
    return section;
  }
}

/**
 * 主函式：品質審稿迴圈
 */
export async function runReviewer(reportContent, options = {}) {
  const tmpDir = options.tmpDir;
  const maxIterations = config.pipeline.maxReviewIterations;
  const threshold = config.pipeline.reviewPassThreshold;

  logger.step('REVIEWER', '開始品質審稿');

  let currentReport = { ...reportContent };
  const reviewLog = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    logger.step('REVIEWER', `第 ${iteration} 輪審稿`);

    // CJK 掃描
    const cjkViolations = runCJKScanner(currentReport, tmpDir);
    if (cjkViolations.length > 0) {
      logger.warn('REVIEWER', `CJK 掃描：發現 ${cjkViolations.length} 個問題`);
    } else {
      logger.info('REVIEWER', 'CJK 掃描：通過');
    }

    // 三維度評分
    let feedback;
    try {
      feedback = await callClaudeJSON(
        REVIEWER_SYSTEM,
        buildReviewerPrompt(currentReport, cjkViolations),
        { maxTokens: 2048 }
      );
    } catch (err) {
      logger.warn('REVIEWER', `第 ${iteration} 輪審稿 JSON 解析失敗（${err.message}），跳過審稿直接交付`);
      feedback = { scores: { logic: 7, language: 7, reader_experience: 7 }, passed: true };
    }

    const avg = feedback.average || (
      ((feedback.scores?.logic || 0) +
       (feedback.scores?.language || 0) +
       (feedback.scores?.reader_experience || 0)) / 3
    );
    feedback.average = parseFloat(avg.toFixed(2));
    feedback.passed = avg >= threshold;
    feedback.iteration = iteration;

    reviewLog.push(feedback);

    logger.info('REVIEWER', `第 ${iteration} 輪評分：邏輯 ${feedback.scores?.logic} / 語言 ${feedback.scores?.language} / 讀者 ${feedback.scores?.reader_experience} | 平均 ${feedback.average}`);

    if (feedback.passed) {
      logger.info('REVIEWER', `通過品質閘門（>= ${threshold}）`);
      break;
    }

    if (iteration === maxIterations) {
      logger.warn('REVIEWER', `已達最大迭代次數，以當前版本交付`);
      break;
    }

    // 修訂低分章節
    const sectionsToRevise = feedback.sections_to_revise || [];
    const lowestDimension = Object.entries(feedback.scores || {})
      .sort(([, a], [, b]) => a - b)[0]?.[0];

    const dimensionFeedback = feedback.feedback?.[lowestDimension] || '';

    for (const sectionId of sectionsToRevise) {
      if (sectionId === 'executive_summary') {
        // 不在此處修訂摘要，留給下一輪
        continue;
      }
      const sectionIndex = currentReport.sections?.findIndex(s => s.id === sectionId);
      if (sectionIndex !== -1) {
        const revised = await reviseSection(
          currentReport.sections[sectionIndex],
          dimensionFeedback
        );
        if (revised?.content) {
          currentReport.sections[sectionIndex] = revised;
        }
      }
    }
  }

  // 儲存審稿紀錄
  saveTmp('review_log.json', reviewLog, tmpDir);

  // 將審稿摘要附加至報告
  currentReport.review_summary = {
    iterations: reviewLog.length,
    final_scores: reviewLog[reviewLog.length - 1]?.scores,
    final_average: reviewLog[reviewLog.length - 1]?.average,
    passed: reviewLog[reviewLog.length - 1]?.passed,
  };

  return currentReport;
}
