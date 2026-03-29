import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { REPORTER_SYSTEM, buildReporterPrompt } from '../src/prompts/reporter.prompt.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const plan = JSON.parse(readFileSync('./tmp/research_plan.json', 'utf-8'));
const analysis = JSON.parse(readFileSync('./tmp/analysis.json', 'utf-8'));

const prompt = buildReporterPrompt(plan, analysis);
console.log('prompt 長度 (chars):', prompt.length);

const res = await client.messages.create({
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  max_tokens: 8192,
  system: REPORTER_SYSTEM,
  messages: [{ role: 'user', content: prompt }],
});

const text = res.content[0].text;
console.log('stop_reason:', res.stop_reason);
console.log('output_tokens:', res.usage.output_tokens);
console.log('input_tokens:', res.usage.input_tokens);
console.log('--- 回應前500字 ---');
console.log(text.slice(0, 500));
console.log('--- 回應後300字 ---');
console.log(text.slice(-300));
