import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env'), override: true });

const REQUIRED_KEYS = ['ANTHROPIC_API_KEY'];

for (const key of REQUIRED_KEYS) {
  if (!process.env[key]) {
    console.error(`[CONFIG] ✗ 缺少必要環境變數：${key}`);
    process.exit(1);
  }
}

// ── Search engine API key diagnostics ──
const SEARCH_KEYS = [
  { env: 'BRAVE_SEARCH_API_KEY', name: 'Brave Search' },
  { env: 'GOOGLE_CSE_API_KEY', name: 'Google CSE (API Key)' },
  { env: 'GOOGLE_CSE_CX', name: 'Google CSE (CX)' },
  { env: 'FIRECRAWL_API_KEY', name: 'Firecrawl' },
  { env: 'EXA_API_KEY', name: 'Exa' },
];

let configuredEngines = 0;
for (const { env, name } of SEARCH_KEYS) {
  const val = process.env[env];
  if (!val || val.trim() === '') {
    console.warn(`[CONFIG] ⚠ ${name} 未設定 (${env})`);
  } else {
    configuredEngines++;
    console.log(`[CONFIG] ✓ ${name} 已設定 (${val.slice(0, 6)}...)`);
  }
}
if (configuredEngines === 0) {
  console.error('[CONFIG] ✗ 沒有任何搜尋引擎 API key 已設定 — 報告將缺乏外部資料來源');
}

export default {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    maxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS || '8192'),
  },
  firecrawl: {
    apiKey: process.env.FIRECRAWL_API_KEY || '',
    baseUrl: 'https://api.firecrawl.dev/v1',
  },
  exa: {
    apiKey: process.env.EXA_API_KEY || '',
    baseUrl: 'https://api.exa.ai',
  },
  google: {
    cseApiKey: process.env.GOOGLE_CSE_API_KEY || '',
    cseCx: process.env.GOOGLE_CSE_CX || '',
  },
  brave: {
    apiKey: process.env.BRAVE_SEARCH_API_KEY || '',
    baseUrl: 'https://api.search.brave.com/res/v1/web/search',
  },
  pipeline: {
    maxSourcesPerQuestion: parseInt(process.env.MAX_SOURCES_PER_QUESTION || '3'),
    maxReviewIterations: parseInt(process.env.MAX_REVIEW_ITERATIONS || '2'),
    reviewPassThreshold: parseFloat(process.env.REVIEW_PASS_THRESHOLD || '7.5'),
    outputDir: process.env.OUTPUT_DIR || './output',
    tmpDir: process.env.TMP_DIR || './tmp',
    logLevel: process.env.LOG_LEVEL || 'info',
  },
};
