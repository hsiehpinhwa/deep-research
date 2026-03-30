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
 * Free axios-based scrape: direct HTTP GET → strip HTML to text.
 * No JS rendering, but works for many financial sites and is free.
 */
async function scrapeFree(url) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
      maxRedirects: 3,
    });
    const html = res.data;
    if (typeof html !== 'string') return null;

    // Strip HTML tags, scripts, styles → plain text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return text.length > 100 ? text.slice(0, MAX_CONTENT_CHARS) : null;
  } catch (err) {
    logger.warn('COLLECTOR', `免費抓取失敗 (${url})：${err.message}`);
    return null;
  }
}

/**
 * Firecrawl 深度抓取單一頁面, with free fallback.
 */
async function scrapeFirecrawl(url) {
  // Try Firecrawl first
  if (config.firecrawl.apiKey) {
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
      if (content.length > 100) return content.slice(0, MAX_CONTENT_CHARS);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      // If credits exhausted, log once and fall through to free scrape
      if (msg.includes('Insufficient credits')) {
        logger.warn('COLLECTOR', `Firecrawl credits 用完，切換免費抓取`);
      } else {
        logger.warn('COLLECTOR', `Firecrawl 抓取失敗 (${url})：${msg}`);
      }
    }
  }

  // Fallback: free axios scrape
  logger.info('COLLECTOR', `使用免費抓取: ${url}`);
  return scrapeFree(url);
}

/**
 * Firecrawl search with Exa fallback.
 * If Firecrawl fails (credits, network), automatically tries Exa.
 */
async function searchWithFallback(query, limit = 5) {
  // Try Firecrawl first
  const fcResults = await searchFirecrawl(query, limit);
  if (fcResults.length > 0) return fcResults;

  // Fallback to Exa
  logger.info('COLLECTOR', `Firecrawl 搜尋無結果，Exa 備援: ${query.slice(0, 50)}...`);
  return searchExa(query, limit);
}

/**
 * Build direct URLs for known financial data pages.
 * These are real pages with structured financial data, not search queries.
 */
function buildDirectFinancialURLs(companyName, ticker, market) {
  const urls = [];

  if (market === 'hk' || market === 'general') {
    // Extract HK stock code: "0148.HK" → "00148", "148" → "00148"
    let hkCode = ticker?.replace(/\.HK$/i, '') || '';
    if (hkCode && hkCode.length < 5) hkCode = hkCode.padStart(5, '0');

    if (hkCode) {
      // AAStocks: company fundamental page (has revenue, profit, margins)
      urls.push({
        url: `http://www.aastocks.com/tc/stocks/analysis/company-fundamental/?symbol=${hkCode}`,
        title: `${companyName} AAStocks 基本面分析`,
      });
      // Yahoo Finance: financials page
      urls.push({
        url: `https://finance.yahoo.com/quote/${hkCode.replace(/^0+/, '')}.HK/financials/`,
        title: `${companyName} Yahoo Finance 財務數據`,
      });
      // Yahoo Finance: profile (company info, sector, employees)
      urls.push({
        url: `https://finance.yahoo.com/quote/${hkCode.replace(/^0+/, '')}.HK/profile/`,
        title: `${companyName} Yahoo Finance 公司概況`,
      });
      // etnet: stock quote page
      urls.push({
        url: `https://www.etnet.com.hk/www/tc/stocks/realtime/quote.php?code=${parseInt(hkCode)}`,
        title: `${companyName} etnet 即時報價`,
      });
    }
  }

  if (market === 'tw') {
    // Extract TW stock code: "2912.TW" → "2912"
    const twCode = ticker?.replace(/\.TW$/i, '') || '';
    if (twCode) {
      // Goodinfo: financial detail (income statement)
      urls.push({
        url: `https://goodinfo.tw/tw/StockFinDetail.asp?STOCK_ID=${twCode}`,
        title: `${companyName} Goodinfo 財務資料`,
      });
      // Goodinfo: assets status (balance sheet)
      urls.push({
        url: `https://goodinfo.tw/tw/StockAssetsStatus.asp?STOCK_ID=${twCode}`,
        title: `${companyName} Goodinfo 資產負債`,
      });
      // Goodinfo: dividend policy
      urls.push({
        url: `https://goodinfo.tw/tw/StockDividendPolicy.asp?STOCK_ID=${twCode}`,
        title: `${companyName} Goodinfo 股利政策`,
      });
    }
  }

  return urls;
}

/**
 * Direct scrape known financial data URLs + targeted searches for a company.
 * Returns array of { url, title, markdown } objects.
 */
async function scrapeDirectFinancialURLs(companyName, ticker, market) {
  const directURLs = buildDirectFinancialURLs(companyName, ticker, market);
  const results = [];

  // Phase 1: Scrape known URLs in parallel (max 4 at a time)
  if (directURLs.length > 0) {
    logger.step('COLLECTOR', `直接抓取 ${directURLs.length} 個財務數據頁面...`);
    const BATCH = 4;
    for (let i = 0; i < directURLs.length; i += BATCH) {
      const batch = directURLs.slice(i, i + BATCH);
      const scraped = await Promise.all(batch.map(async ({ url, title }) => {
        logger.info('COLLECTOR', `  抓取: ${url}`);
        const content = await scrapeFirecrawl(url);
        if (content && content.length > 200) {
          return { url, title, markdown: content };
        }
        logger.warn('COLLECTOR', `  失敗或內容不足: ${url}`);
        return null;
      }));
      results.push(...scraped.filter(Boolean));
    }
  }

  // Phase 2: Targeted search for annual reports and financial news
  const searchQueries = [
    `"${companyName}" 2024 年報 業績 營收`,
    `"${companyName}" annual results 2024 revenue profit`,
  ];

  for (const q of searchQueries) {
    if (results.length >= 6) break;
    logger.info('COLLECTOR', `  搜尋: ${q}`);
    const searchResults = await searchWithFallback(q, 3);
    results.push(...searchResults);
  }

  logger.info('COLLECTOR', `直接抓取財務資料：共取得 ${results.length} 個來源`);
  return results;
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
 * 處理單一子問題（exported for gapFill reuse）
 * @param {object} question - sub_question from planner
 * @param {number} maxSources - max sources per question
 * @param {object} planMeta - { research_mode, market } from plan
 */
export async function collectForQuestion(question, maxSources, planMeta = {}) {
  const kw = question.search_keywords;
  const isCompany = planMeta.research_mode === 'company';
  const market = planMeta.market || 'general';

  // 中文搜尋為主，英文補充（不再強制加年份 — 讓 Planner 的 keywords 自帶年份）
  const queries = [kw.zh, kw.en].filter(Boolean);
  logger.step('COLLECTOR', `[${question.id}] 搜尋：${queries[0]}${isCompany ? ` (企業研究/${market})` : ''}`);

  let allResults = [];

  if (isCompany) {
    // ── Company mode: three-pass search ──
    const siteSuffix = buildSiteSuffix(market);

    // Pass 1: site-scoped search (e.g. goodinfo + 建滔集團 營收)
    const scopedQuery = `${kw.zh} ${siteSuffix}`;
    logger.info('COLLECTOR', `[${question.id}] Pass 1 目標網站: ${scopedQuery.slice(0, 80)}...`);
    const scopedResults = await searchWithFallback(scopedQuery, 3);
    allResults.push(...scopedResults);

    // Pass 2: general Chinese search
    if (allResults.length < 6) {
      logger.info('COLLECTOR', `[${question.id}] Pass 2 一般搜尋: ${kw.zh}`);
      const zhResults = await searchWithFallback(kw.zh, 4);
      allResults.push(...zhResults);
    }

    // Pass 3: English search for broader coverage
    if (allResults.length < 6 && kw.en) {
      logger.info('COLLECTOR', `[${question.id}] Pass 3 英文搜尋: ${kw.en}`);
      const enResults = await searchWithFallback(kw.en, 3);
      allResults.push(...enResults);
    }
  } else {
    // ── Market mode ──
    for (const q of queries) {
      if (allResults.length >= 6) break;
      const results = await searchWithFallback(q, 4);
      allResults.push(...results);
    }
  }

  // searchWithFallback already tries Exa, no need for separate fallback

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

  // ── Pass 0: Direct financial data scraping (company mode only) ──
  // Grab annual reports, Goodinfo pages, HKEX filings BEFORE question-based search
  let directFinancialSources = [];
  if (planMeta.research_mode === 'company') {
    logger.step('COLLECTOR', '直接抓取官方財務資料（年報、港交所、Goodinfo）...');
    directFinancialSources = await scrapeDirectFinancialURLs(
      plan.company_name || plan.topic,
      plan.ticker || '',
      planMeta.market
    );
  }

  const results = [];

  const BATCH_SIZE = 3;
  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    const batch = questions.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(q => collectForQuestion(q, maxSources, planMeta))
    );
    // Inject direct financial sources into each question's results
    // so every analyzer call has access to core financial data
    for (const r of batchResults) {
      for (const ds of directFinancialSources) {
        if (!r.sources.some(s => s.url === ds.url)) {
          r.sources.push({
            url: ds.url,
            title: ds.title || '',
            content: (ds.markdown || '').slice(0, MAX_CONTENT_CHARS),
            fetched_at: new Date().toISOString(),
            domain: (() => { try { return new URL(ds.url).hostname; } catch { return ''; } })(),
          });
        }
      }
    }
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
