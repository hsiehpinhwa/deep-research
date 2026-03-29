import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { saveTmp, outputPath, rootPath, tmpPath } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';

/**
 * 生成來源清單 Markdown
 */
function buildSourcesMarkdown(reportContent) {
  const meta = reportContent.meta || {};
  const sources = reportContent.sources || [];
  const date = new Date().toLocaleDateString('zh-TW');

  const lines = [
    `# ${meta.title || '研究報告'} — 資料來源`,
    '',
    `> 生成日期：${date}`,
    `> 來源總數：${sources.length}`,
    '',
    '---',
    '',
  ];

  sources.forEach((source, i) => {
    lines.push(`### [${i + 1}] ${source.title || '未知來源'}`);
    lines.push(`- **URL**：${source.url || '—'}`);
    if (source.accessed) lines.push(`- **擷取日期**：${source.accessed}`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * 呼叫 Python .docx 生成器
 */
function callDocxGenerator(inputPath, outputDir) {
  const pythonScript = rootPath('tools', 'generate_docx.py');
  const result = spawnSync('python3', [
    pythonScript,
    '--input', inputPath,
    '--output-dir', outputDir,
  ], { encoding: 'utf-8' });

  if (result.error) {
    throw new Error(`Python docx 生成器執行失敗：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Python docx 生成器錯誤：${result.stderr}`);
  }

  logger.info('DELIVERER', result.stdout.trim());
  return result.stdout;
}

/**
 * 主函式：生成所有交付物
 */
export async function runDeliverer(reportContent) {
  logger.step('DELIVERER', '開始生成交付物');

  const topic = reportContent.meta?.topic || 'report';
  const safeTopicShort = topic.slice(0, 20).replace(/[/\\?%*:|"<>]/g, '_');
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outDir = outputPath('').replace(/\/$/, '');  // ensure no trailing slash

  // 1. 儲存最終 report_content.json（含審稿紀錄）
  const finalJsonPath = tmpPath('report_content_final.json');
  saveTmp('report_content_final.json', reportContent);

  // 2. 呼叫 Python 生成 .docx（完整報告 + 摘要卡）
  try {
    callDocxGenerator(finalJsonPath, outDir);
  } catch (err) {
    logger.error('DELIVERER', `docx 生成失敗：${err.message}`);
    logger.warn('DELIVERER', '繼續生成其他交付物...');
  }

  // 3. 生成來源清單 .md
  const sourcesMarkdown = buildSourcesMarkdown(reportContent);
  const sourcesPath = outputPath(`${safeTopicShort}_來源清單_${dateStr}.md`);
  writeFileSync(sourcesPath, sourcesMarkdown, 'utf-8');
  logger.info('DELIVERER', `來源清單已生成：${sourcesPath}`);

  logger.info('DELIVERER', `所有交付物已輸出至 output/`);

  return {
    outputDir: outDir,
    topic,
    dateStr,
  };
}
