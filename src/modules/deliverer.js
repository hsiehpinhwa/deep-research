import { spawnSync } from 'child_process';
import { writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
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
// Use venv Python on Railway (has python-docx), fallback to system python3 locally
const PYTHON_CMD = process.env.PYTHON_CMD || '/app/.venv/bin/python3';

function callDocxGenerator(inputPath, outputDir) {
  const pythonScript = rootPath('tools', 'generate_docx.py');
  const result = spawnSync(PYTHON_CMD, [
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
export async function runDeliverer(reportContent, options = {}) {
  logger.step('DELIVERER', '開始生成交付物');

  const tmpDir = options.tmpDir;
  const outDir = options.outDir || outputPath('').replace(/\/$/, '');

  // 確保 outDir 存在
  mkdirSync(outDir, { recursive: true });

  const topic = reportContent.meta?.topic || 'report';
  const safeTopicShort = topic.slice(0, 20).replace(/[/\\?%*:|"<>]/g, '_');
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // 儲存最終 report_content_final.json（含審稿紀錄）
  saveTmp('report_content_final.json', reportContent, tmpDir);
  const finalJsonPath = tmpPath('report_content_final.json', tmpDir);

  // 呼叫 Python 生成 .docx（完整報告 + 摘要卡）
  try {
    callDocxGenerator(finalJsonPath, outDir);
  } catch (err) {
    logger.error('DELIVERER', `docx 生成失敗：${err.message}`);
    logger.error('DELIVERER', err.stack || '');
    logger.warn('DELIVERER', '繼續生成其他交付物（無 .docx 附件）...');
  }

  // 找到生成的 .docx 路徑（供 mailer.js 讀取）
  let docxPath = null;
  let summaryPath = null;
  try {
    const files = readdirSync(outDir);
    const fullReport = files.find(f => f.includes('完整報告') && f.endsWith('.docx'));
    const summary    = files.find(f => f.includes('摘要卡')   && f.endsWith('.docx'));
    if (fullReport) docxPath    = join(outDir, fullReport);
    if (summary)    summaryPath = join(outDir, summary);
  } catch { /* 不影響主流程 */ }

  // 生成來源清單 .md
  const sourcesMarkdown = buildSourcesMarkdown(reportContent);
  const sourcesFilePath = join(outDir, `${safeTopicShort}_來源清單_${dateStr}.md`);
  writeFileSync(sourcesFilePath, sourcesMarkdown, 'utf-8');
  logger.info('DELIVERER', `來源清單已生成：${sourcesFilePath}`);

  logger.info('DELIVERER', `所有交付物已輸出至 ${outDir}`);

  return { outputDir: outDir, topic, dateStr, docxPath, summaryPath };
}
