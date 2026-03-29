import Anthropic from '@anthropic-ai/sdk';
import config from '../config.js';
import { logger } from './logger.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * 從可能含說明文字的 Claude 輸出中萃取 JSON
 */
function extractJSON(text) {
  // 優先嘗試直接解析
  try {
    return JSON.parse(text.trim());
  } catch {}

  // 萃取 markdown code block（含有 ``` 結尾）
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }

  // 萃取未閉合的 code block（回應被截斷時）
  const openCodeBlock = text.match(/```(?:json)?\s*([\s\S]+)/);
  if (openCodeBlock) {
    try { return JSON.parse(openCodeBlock[1].trim()); } catch {}
  }

  // 萃取最外層的 { } 或 [ ]（貪婪，取最長匹配）
  const objMatch = text.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try { return JSON.parse(objMatch[1]); } catch {}
  }

  const arrMatch = text.match(/(\[[\s\S]*\])/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[1]); } catch {}
  }

  // 印出原始回應供除錯
  console.error('[CLAUDE] 無法解析 JSON，回應前300字：\n', text.slice(0, 300));
  throw new Error('無法從回應中萃取有效 JSON');
}

/**
 * 呼叫 Claude，含指數退避重試
 * @param {string} systemPrompt
 * @param {string} userContent
 * @param {object} options
 * @returns {Promise<string>} 原始文字回應
 */
export async function callClaude(systemPrompt, userContent, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const model = options.model ?? config.anthropic.model;
  const maxTokens = options.maxTokens ?? config.anthropic.maxTokens;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });
      return response.content[0].text;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const wait = Math.pow(2, attempt) * 1000;
      logger.warn('CLAUDE', `呼叫失敗（第 ${attempt} 次），${wait / 1000}s 後重試：${err.message}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

/**
 * 呼叫 Claude 並強制回傳解析後的 JSON
 */
export async function callClaudeJSON(systemPrompt, userContent, options = {}) {
  const text = await callClaude(systemPrompt, userContent, options);
  return extractJSON(text);
}
