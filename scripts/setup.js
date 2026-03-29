#!/usr/bin/env node
/**
 * DeepBrief AI — 環境設定檢查腳本
 * 執行：node scripts/setup.js
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

console.log('\n🔍 DeepBrief AI — 環境檢查\n');

const checks = [];

// 1. .env 檔案
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  const hasAnthropicKey = /ANTHROPIC_API_KEY=sk-/.test(envContent);
  checks.push({ name: '.env 檔案', pass: true });
  checks.push({ name: 'ANTHROPIC_API_KEY', pass: hasAnthropicKey, warn: !hasAnthropicKey ? '未填入有效的 API Key' : null });

  const hasFirecrawl = /FIRECRAWL_API_KEY=fc-/.test(envContent);
  const hasExa = /EXA_API_KEY=exa-/.test(envContent);
  checks.push({ name: 'FIRECRAWL_API_KEY', pass: hasFirecrawl, warn: !hasFirecrawl ? '未設定（網路蒐集功能將跳過）' : null, optional: true });
  checks.push({ name: 'EXA_API_KEY', pass: hasExa, warn: !hasExa ? '未設定（搜尋功能將跳過）' : null, optional: true });
} else {
  checks.push({ name: '.env 檔案', pass: false, warn: '請複製 .env.example 為 .env 並填入 API Keys' });
  // 自動複製範本
  const examplePath = join(ROOT, '.env.example');
  if (existsSync(examplePath)) {
    writeFileSync(envPath, readFileSync(examplePath, 'utf-8'));
    console.log('  ➜ 已自動複製 .env.example 為 .env，請填入您的 API Keys\n');
  }
}

// 2. Node.js 模組
const nodeModulesPath = join(ROOT, 'node_modules', '@anthropic-ai');
checks.push({ name: 'node_modules (@anthropic-ai/sdk)', pass: existsSync(nodeModulesPath) });

// 3. Python
const pythonResult = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
const pythonOk = pythonResult.status === 0;
checks.push({ name: `Python 3 (${pythonResult.stdout?.trim() || 'not found'})`, pass: pythonOk });

// 4. python-docx
const docxResult = spawnSync('python3', ['-c', 'from docx import Document; print("OK")'], { encoding: 'utf-8' });
checks.push({ name: 'python-docx', pass: docxResult.stdout?.includes('OK') });

// 5. 目錄結構
const requiredDirs = ['src/modules', 'src/utils', 'src/prompts', 'tools', 'tmp', 'output', 'workflows'];
for (const dir of requiredDirs) {
  checks.push({ name: `目錄：${dir}/`, pass: existsSync(join(ROOT, dir)) });
}

// 輸出結果
let allCriticalPassed = true;
for (const check of checks) {
  const icon = check.pass ? '✅' : (check.optional ? '⚠️ ' : '❌');
  const note = check.warn ? ` — ${check.warn}` : '';
  console.log(`  ${icon} ${check.name}${note}`);
  if (!check.pass && !check.optional) allCriticalPassed = false;
}

console.log();
if (allCriticalPassed) {
  console.log('✅ 環境設定完整，可以開始使用！');
  console.log('\n執行研究：');
  console.log('  node src/index.js --topic "台灣半導體產業 2026 展望"\n');
} else {
  console.log('❌ 請修正以上問題後再執行。\n');
  console.log('最快設定方式：');
  console.log('  1. 編輯 .env，填入 ANTHROPIC_API_KEY=sk-ant-...');
  console.log('  2. node src/index.js --topic "測試主題" --skip-review\n');
}
