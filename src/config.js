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
  pipeline: {
    maxSourcesPerQuestion: parseInt(process.env.MAX_SOURCES_PER_QUESTION || '3'),
    maxReviewIterations: parseInt(process.env.MAX_REVIEW_ITERATIONS || '2'),
    reviewPassThreshold: parseFloat(process.env.REVIEW_PASS_THRESHOLD || '7.5'),
    outputDir: process.env.OUTPUT_DIR || './output',
    tmpDir: process.env.TMP_DIR || './tmp',
    logLevel: process.env.LOG_LEVEL || 'info',
  },
};
