import axios from 'axios';
import { saveTmp, loadTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import config from '../config.js';

const MAX_CONTENT_CHARS = 6000;

// ── Company research: targeted financial sites by market ──

const COMPANY_SITES = {
  tw: [
    'goodinfo.tw',
    'mops.twse.com.tw',
    'moneydj.com',
    'money.udn.com',
    'cnyes.com',
    'cw.com.tw',
  ],
  hk: [
    'aastocks.com',
    'hkexnews.hk',
    'finance.now.com',
    'cnyes.com',
    'hk01.com',
  ],
  general: [
    'cnyes.com',
    'cw.com.tw',
    'money.udn.com',
  ],
};

/**
 * Build site-scoped search suffix for company research.
 * Returns e.g. "site:goodinfo.tw OR site:mops.twse.com.tw"
 * Only the top 3 sites are used to keep query concise.
 */
function buildSiteSuffix(market) {
  const sites = COMPANY_SITES[market] || COMPANY_SITES.general;
  return sites.slice(0, 3).map(s => `site:${s}`).join(' OR ');
}

/**
 * Firecrawl 搜尋（主要搜尋引擎）
 */
async function searchFirecrawl(query, limit = 5) {
  if (!config.firecrawl.apiKey) return [];
  try {
    const res = await axios.post(
      `${config.firecrawl.baseUrl}/search`,
      { query, limit, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } },
      {
        headers: { Authorization: `Bearer ${config.firecrawl.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return res.data.data || [];
  } catch (err) {
    logger.warn('COLLECTOR', `Firecrawl 搜尋失敗：${err.response?.status} ${err.message}`);
    return [];
  }
}

/**
 * Firecrawl 深度抓取單一頁面
 */
async function scrapeFirecrawl(url) {
  if (!config.firecrawl.apiKey) return null;
  try {
    const res = await axios.post(
      `${config.firecrawl.baseUrl}/scrape`,
      { url, formats: ['markdown'], onlyMainContent: true },
      {
        headers: { Authorization: `Bearer ${config.firecrawl.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 25000,
      }
    );
    const content = res.data?.data?.markdown || res.data?.markdown || '';
    return content.slice(0, MAX_CONTENT_CHARS);
  } catch (err) {
    logger.warn('COLLECTOR', `Firecrawl 抓取失敗 (${url})：${err.message}`);
    return null;
  }
}

/**
 * Exa 搜尋（備援）
 */
async function searchExa(query, numResults = 5) {
  if (!config.exa.apiKey) return [];
  try {
    const res = await axios.post(
      `${config.exa.baseUrl}/search`,
      { query, numResults, type: 'neural', useAutoprompt: true, contents: { text: { maxCharacters: 3000 } } },
      {
        headers: { 'x-api-key': config.exa.apiKey, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    return (res.data.results || []).map(r => ({
      url: r.url,
      title: r.title,
      markdown: r.text || '',
    }));
  } catch (err) {
    logger.warn('COLLECTOR', `Exa 備援搜尋失敗：${err.response?.status}`);
    return [];
  }
}

/**
 * Add recency suffix to search queries.
 * Ensures we don't get stale 2022-era articles when it's 2026.
 */
function addRecencySuffix(query) {
  // If query already has a year, don't add
  if (/202[4-9]/.test(query)) return query;
  return `${query} 2025 2026`;
}

/**
 * 處理單一子問題
 * @param {object} question - sub_question from planner
 * @param {number} maxSources - max sources per question
 * @param {object} planMeta - { research_mode, market } from plan
 */
async function collectForQuestion(question, maxSources, planMeta = {}) {
  const kw = question.search_keywords;
  const isCompany = planMeta.research_mode === 'company';
  const market = planMeta.market || 'general';

  // 中文搜尋為主，英文補充 — 加年份確保時效性
  const queries = [kw.zh, kw.en].filter(Boolean).map(addRecencySuffix);
  logger.step('COLLECTOR', `[${question.id}] 搜尋：${queries[0]}${isCompany ? ` (企業研究/${market})` : ''}`);

  let allResults = [];

  if (isCompany) {
    // ── Company mode: two-pass search ──
    // Pass 1: site-scoped search for structured financial data (with recency)
    const siteSuffix = buildSiteSuffix(market);
    const scopedQuery = addRecencySuffix(`${kw.zh} ${siteSuffix}`);
    logger.info('COLLECTOR', `[${question.id}] 目標網站搜尋: ${scopedQuery.slice(0, 80)}...`);
    const scopedResults = await searchFirecrawl(scopedQuery, 3);
    allResults.push(...scopedResults);

    // Pass 2: general search for broader coverage (news, analysis, etc.)
    for (const q of queries) {
      if (allResults.length >= 8) break;
      const results = await searchFirecrawl(q, 3);
      allResults.push(...results);
    }
  } else {
    // ── Market mode: original behavior (with recency) ──
    for (const q of queries) {
      if (allResults.length >= 6) break;
      const results = await searchFirecrawl(q, 4);
      allResults.push(...results);
    }
  }

  // Firecrawl 無結果時用 Exa 備援
  if (allResults.length === 0) {
    logger.warn('COLLECTOR', `[${question.id}] Firecrawl 無結果，嘗試 Exa 備援`);
    allResults = await searchExa(queries[0], 5);
  }

  const sources = [];
  const seenDomains = new Set();

  for (const result of allResults) {
    if (sources.length >= maxSources) break;
    if (!result.url) continue;

    let domain;
    try { domain = new URL(result.url).hostname; } catch { continue; }
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);

    // Firecrawl search 已包含 markdown 內容
    let content = result.markdown || result.text || '';

    // 內容不足時補抓
    if (content.length < 300 && config.firecrawl.apiKey) {
      content = (await scrapeFirecrawl(result.url)) || content;
    }

    if (!content || content.length < 100) {
      logger.warn('COLLECTOR', `[${question.id}] 內容過短，跳過：${domain}`);
      continue;
    }

    sources.push({
      url: result.url,
      title: result.title || '',
      content: content.slice(0, MAX_CONTENT_CHARS),
      fetched_at: new Date().toISOString(),
      domain,
    });

    logger.info('COLLECTOR', `[${question.id}] ✓ ${domain} (${content.length} chars)`);
  }

  if (sources.length === 0) {
    logger.warn('COLLECTOR', `[${question.id}] 無任何來源，將以 Claude 知識填充`);
  }

  return { question_id: question.id, question: question.question, sources };
}

/**
 * 主函式
 */
export async function runCollector(plan, options = {}) {
  const tmpDir = options.tmpDir;
  const cacheKey = 'raw_sources.json';

  if (!options.force) {
    const cached = loadTmp(cacheKey, tmpDir);
    if (cached) {
      logger.info('COLLECTOR', `使用快取的來源資料`);
      return cached;
    }
  }

  const maxSources = config.pipeline.maxSourcesPerQuestion;
  const questions = plan.sub_questions || [];
  const planMeta = {
    research_mode: plan.research_mode || 'market',
    market: plan.market || 'general',
  };

  if (planMeta.research_mode === 'company') {
    logger.step('COLLECTOR', `企業研究模式：${plan.company_name || plan.topic}（${planMeta.market}）`);
  }

  const results = [];

  const BATCH_SIZE = 3;
  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    const batch = questions.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(q => collectForQuestion(q, maxSources, planMeta))
    );
    results.push(...batchResults);
    if (i + BATCH_SIZE < questions.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  const path = saveTmp(cacheKey, results, tmpDir);
  const totalSources = results.reduce((sum, r) => sum + r.sources.length, 0);
  logger.info('COLLECTOR', `蒐集完成：${totalSources} 個來源 → ${path}`);

  return results;
}

// CLI 直接執行
if (process.argv[1]?.endsWith('collector.js')) {
  const plan = loadTmp('research_plan.json');
  if (!plan) { console.error('找不到 research_plan.json'); process.exit(1); }
  await runCollector(plan, { force: true });
}
