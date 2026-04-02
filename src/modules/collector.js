import axios from 'axios';
import { saveTmp, loadTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import config from '../config.js';

const MAX_CONTENT_CHARS = 10000;

// ── Firecrawl exhaustion flag (module-level, persists across calls within same job) ──
let firecrawlExhausted = false;

// ── Taiwan financial media — for market research Pass 2 ──

const TW_FINANCIAL_MEDIA = [
  'ctee.com.tw',           // 工商時報
  'money.udn.com',         // 經濟日報
  'wealth.com.tw',         // 財訊
  'cw.com.tw',             // 天下雜誌
  'businessweekly.com.tw', // 商業周刊
  'gvm.com.tw',            // 遠見雜誌
];

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
  if (!config.firecrawl.apiKey || firecrawlExhausted) return [];
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
    const msg = err.response?.data?.error || err.message;
    if (String(msg).includes('Insufficient credits') || String(msg).includes('insufficient')) {
      firecrawlExhausted = true;
      logger.warn('COLLECTOR', 'Firecrawl credits 用完，本次 job 後續全部跳過 Firecrawl');
    } else {
      logger.warn('COLLECTOR', `Firecrawl 搜尋失敗：${err.response?.status} ${msg}`);
    }
    return [];
  }
}

/**
 * Google Custom Search API（免費 100 次/天）
 */
async function searchGoogle(query, limit = 5) {
  if (!config.google?.cseApiKey || !config.google?.cseCx) return [];
  try {
    const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: config.google.cseApiKey,
        cx: config.google.cseCx,
        q: query,
        num: Math.min(limit, 10),
      },
      timeout: 10000,
    });
    const items = res.data.items || [];

    // Google CSE only returns snippets (~200 chars). Auto-scrape top results for full content.
    const results = [];
    for (const item of items.slice(0, Math.min(limit, 5))) {
      let content = item.snippet || '';

      // Try to scrape full page content (free, no Firecrawl credits)
      if (content.length < 500) {
        const fullContent = await scrapeFree(item.link);
        if (fullContent && fullContent.length > content.length) {
          content = fullContent;
          logger.info('COLLECTOR', `  Google CSE 補抓成功: ${item.link.slice(0, 60)}... (${fullContent.length} chars)`);
        }
      }

      results.push({ url: item.link, title: item.title, markdown: content });
    }
    return results;
  } catch (err) {
    logger.warn('COLLECTOR', `Google CSE 搜尋失敗：${err.response?.status} ${err.message}`);
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
  // Try Firecrawl first (skip entirely if credits exhausted)
  if (config.firecrawl.apiKey && !firecrawlExhausted) {
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
      const msg = String(err.response?.data?.error || err.message);
      if (msg.includes('Insufficient credits') || msg.includes('insufficient')) {
        firecrawlExhausted = true;
        logger.warn('COLLECTOR', 'Firecrawl credits 用完，本次 job 後續全部跳過');
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
 * Brave Search API（免費 2000 次/月，搜尋品質優）
 */
async function searchBrave(query, limit = 5) {
  if (!config.brave?.apiKey) return [];
  try {
    const res = await axios.get(config.brave.baseUrl, {
      params: {
        q: query,
        count: Math.min(limit, 20),
        text_decorations: false,
        search_lang: 'zh-hant',
      },
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': config.brave.apiKey,
      },
      timeout: 10000,
    });
    const items = res.data?.web?.results || [];

    // Brave returns description (~300 chars). Auto-scrape top results for full content.
    const results = [];
    for (const item of items.slice(0, Math.min(limit, 5))) {
      let content = item.description || '';

      // Try to scrape full page content (free, no API credits)
      if (content.length < 500) {
        const fullContent = await scrapeFree(item.url);
        if (fullContent && fullContent.length > content.length) {
          content = fullContent;
          logger.info('COLLECTOR', `  Brave 補抓成功: ${item.url.slice(0, 60)}... (${fullContent.length} chars)`);
        }
      }

      results.push({ url: item.url, title: item.title, markdown: content });
    }
    return results;
  } catch (err) {
    logger.warn('COLLECTOR', `Brave Search 搜尋失敗：${err.response?.status} ${err.message}`);
    return [];
  }
}

/**
 * Four-tier search fallback: Firecrawl → Brave → Google CSE → Exa
 */
async function searchWithFallback(query, limit = 5) {
  // Tier 1: Firecrawl (paid, best quality — search + full content)
  const fcResults = await searchFirecrawl(query, limit);
  if (fcResults.length > 0) {
    logger.info('COLLECTOR', `🔍 搜尋成功 [Firecrawl] ${fcResults.length} 筆: ${query.slice(0, 40)}...`);
    return fcResults;
  }

  // Tier 2: Brave Search (free 2000/month, good quality)
  const hasBrave = !!config.brave?.apiKey;
  logger.info('COLLECTOR', `Firecrawl 無結果，Brave 備援 (key=${hasBrave ? '有' : '❌ 無'}): ${query.slice(0, 50)}...`);
  const braveResults = await searchBrave(query, limit);
  if (braveResults.length > 0) {
    logger.info('COLLECTOR', `🔍 搜尋成功 [Brave] ${braveResults.length} 筆: ${query.slice(0, 40)}...`);
    return braveResults;
  }

  // Tier 3: Google Custom Search (free 100/day)
  const hasGoogle = !!(config.google?.cseApiKey && config.google?.cseCx);
  logger.info('COLLECTOR', `Brave 無結果，Google CSE 備援 (key=${hasGoogle ? '有' : '❌ 無'}): ${query.slice(0, 50)}...`);
  const googleResults = await searchGoogle(query, limit);
  if (googleResults.length > 0) {
    logger.info('COLLECTOR', `🔍 搜尋成功 [Google CSE] ${googleResults.length} 筆: ${query.slice(0, 40)}...`);
    return googleResults;
  }

  // Tier 4: Exa (neural search)
  const hasExa = !!config.exa?.apiKey;
  logger.info('COLLECTOR', `Google CSE 無結果，Exa 備援 (key=${hasExa ? '有' : '❌ 無'}): ${query.slice(0, 50)}...`);
  const exaResults = await searchExa(query, limit);
  if (exaResults.length > 0) {
    logger.info('COLLECTOR', `🔍 搜尋成功 [Exa] ${exaResults.length} 筆: ${query.slice(0, 40)}...`);
  } else {
    logger.warn('COLLECTOR', `⚠️ 所有搜尋引擎均無結果: ${query.slice(0, 60)}`);
  }
  return exaResults;
}

/**
 * Taiwan industry statistics sources — map topic keywords to known authoritative URLs.
 * Returns array of { url, title, searchQuery? } entries.
 */
function buildDirectMarketURLs(topic) {
  const t = (topic || '').toLowerCase();
  const urls = [];

  // ── Always include: Taiwan international trade statistics ──
  urls.push({
    url: 'https://www.trade.gov.tw/Pages/List.aspx?nodeID=1375',
    title: '國際貿易署 — 進出口統計資料',
  });

  // ── Furniture / 家具 ──
  if (/家具|傢俱|furniture/.test(t)) {
    urls.push(
      { url: 'https://www.tfma.org.tw/report/2023', title: '台灣區家具工業同業公會 2023 年報' },
      { url: 'https://www.tfma.org.tw/report/2024', title: '台灣區家具工業同業公會 2024 年報' },
      { url: 'https://www.tfma.org.tw/report', title: '台灣區家具工業同業公會 統計報告' },
    );
  }

  // ── Food & Beverage / 食品飲料 ──
  if (/食品|飲料|beverage|food/.test(t)) {
    urls.push({ url: 'https://www.tfda.moa.gov.tw/index.aspx', title: '食品藥物管理署 統計資料' });
  }

  // ── Semiconductor / 半導體 ──
  if (/半導體|ic|晶圓|semiconductor/.test(t)) {
    urls.push(
      { url: 'https://www.moea.gov.tw/Mns/populace/news/News.aspx?kind=1', title: '經濟部 半導體產業資訊' },
      { url: 'https://www.tsia.org.tw/', title: '台灣半導體產業協會' },
    );
  }

  // ── Retail / 零售 ──
  if (/零售|retail|百貨|超市/.test(t)) {
    urls.push({ url: 'https://www.census.gov.tw/lp.asp?CtNode=21052&CtUnit=14565&BaseDSD=7', title: '主計總處 零售業統計' });
  }

  // ── Real Estate / 房地產 ──
  if (/房地產|不動產|real estate|住宅/.test(t)) {
    urls.push({ url: 'https://pip.moi.gov.tw/V3/E/SCRE0101.aspx', title: '內政部不動產資訊平台' });
  }

  // ── Supplement search queries targeting stats sources ──
  const statsQueries = [
    `${topic} 進口 出口 金額 統計 site:trade.gov.tw`,
    `${topic} 同業公會 統計 台灣 2023 2024`,
  ];

  return { directURLs: urls, statsQueries };
}

/**
 * Scrape direct market statistics URLs for Taiwan market research.
 * Equivalent of scrapeDirectFinancialURLs but for industry/market topics.
 */
async function scrapeDirectMarketURLs(topic) {
  const { directURLs, statsQueries } = buildDirectMarketURLs(topic);
  const results = [];
  const allAttemptedUrls = []; // 記錄所有嘗試過的 URL（含失敗的）

  // Scrape known URLs
  if (directURLs.length > 0) {
    logger.step('COLLECTOR', `抓取 ${directURLs.length} 個台灣統計來源頁面...`);
    const scraped = await Promise.all(directURLs.map(async ({ url, title }) => {
      logger.info('COLLECTOR', `  抓取: ${url}`);
      // 不論結果如何，都記錄嘗試過的 URL
      allAttemptedUrls.push({ url, title });
      const content = await scrapeFirecrawl(url);
      if (content && content.length > 200) return { url, title, markdown: content };
      logger.warn('COLLECTOR', `  失敗或內容不足: ${url}`);
      return null;
    }));
    results.push(...scraped.filter(Boolean));
  }

  // Additional stats-targeted search queries
  for (const q of statsQueries) {
    if (results.length >= 8) break;
    logger.info('COLLECTOR', `  統計來源搜尋: ${q}`);
    const found = await searchWithFallback(q, 3);
    for (const f of found) {
      if (f.url) allAttemptedUrls.push({ url: f.url, title: f.title || '' });
    }
    results.push(...found);
  }

  logger.info('COLLECTOR', `直接抓取市場統計資料：成功 ${results.length} / 嘗試 ${allAttemptedUrls.length} 個來源`);
  return { results, allAttemptedUrls };
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
  const allAttemptedUrls = []; // 記錄所有嘗試過的 URL

  // Phase 1: Scrape known URLs in parallel (max 4 at a time)
  if (directURLs.length > 0) {
    logger.step('COLLECTOR', `直接抓取 ${directURLs.length} 個財務數據頁面...`);
    const BATCH = 4;
    for (let i = 0; i < directURLs.length; i += BATCH) {
      const batch = directURLs.slice(i, i + BATCH);
      const scraped = await Promise.all(batch.map(async ({ url, title }) => {
        logger.info('COLLECTOR', `  抓取: ${url}`);
        allAttemptedUrls.push({ url, title });
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

  // Phase 2: Targeted searches — annual reports, financial news, industry analysis
  const searchQueries = [
    `"${companyName}" 2024 年報 業績 營收 毛利率`,
    `"${companyName}" 2025 中期報告 業績 盈利`,
    `"${companyName}" annual results 2024 2025 revenue profit margin`,
    `"${companyName}" 股權結構 大股東 管理層`,
    `"${companyName}" 競爭 市佔率 行業排名`,
  ];

  for (const q of searchQueries) {
    if (results.length >= 12) break;
    logger.info('COLLECTOR', `  搜尋: ${q}`);
    const searchResults = await searchWithFallback(q, 4);
    for (const sr of searchResults) {
      if (sr.url) allAttemptedUrls.push({ url: sr.url, title: sr.title || '' });
    }
    results.push(...searchResults);
  }

  logger.info('COLLECTOR', `直接抓取財務資料：成功 ${results.length} / 嘗試 ${allAttemptedUrls.length} 個來源`);
  return { results, allAttemptedUrls };
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
    // Pass 1: general search (Chinese + English)
    for (const q of queries) {
      if (allResults.length >= 6) break;
      const results = await searchWithFallback(q, 4);
      allResults.push(...results);
    }

    // Pass 2: Taiwan financial media — 工商時報, 經濟日報, 天下, 商周, 遠見, 財訊
    if (allResults.length < 8) {
      const mediaSuffix = TW_FINANCIAL_MEDIA.slice(0, 5).map(s => `site:${s}`).join(' OR ');
      const mediaQuery = `${kw.zh} ${mediaSuffix}`;
      logger.info('COLLECTOR', `[${question.id}] Pass 2 台灣財經媒體: ${mediaQuery.slice(0, 80)}...`);
      const mediaResults = await searchWithFallback(mediaQuery, 4);
      allResults.push(...mediaResults);
    }
  }

  // searchWithFallback already tries Exa, no need for separate fallback

  const sources = [];
  const references = []; // 所有搜尋到的 URL（含內容不足的），用於報告附錄
  const seenDomains = new Set();
  const seenRefUrls = new Set();

  for (const result of allResults) {
    if (!result.url) continue;

    let domain;
    try { domain = new URL(result.url).hostname; } catch { continue; }

    // 記錄所有搜尋到的 URL 作為參考來源（不論內容是否足夠）
    if (!seenRefUrls.has(result.url)) {
      seenRefUrls.add(result.url);
      references.push({
        url: result.url,
        title: result.title || domain,
        domain,
        fetched_at: new Date().toISOString(),
      });
    }

    if (sources.length >= maxSources) continue;
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);

    // Firecrawl search 已包含 markdown 內容
    let content = result.markdown || result.text || '';

    // 內容不足時補抓
    if (content.length < 300 && config.firecrawl.apiKey) {
      content = (await scrapeFirecrawl(result.url)) || content;
    }

    if (!content || content.length < 100) {
      logger.warn('COLLECTOR', `[${question.id}] 內容過短，跳過分析：${domain}`);
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

  return { question_id: question.id, question: question.question, sources, references };
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

  // ── Pass 0: Direct data scraping before question-based search ──
  let directFinancialSources = [];
  let allDirectUrls = []; // 所有嘗試過的直連 URL（含失敗的）
  if (planMeta.research_mode === 'company') {
    logger.step('COLLECTOR', '直接抓取官方財務資料（年報、港交所、Goodinfo）...');
    const directResult = await scrapeDirectFinancialURLs(
      plan.company_name || plan.topic,
      plan.ticker || '',
      planMeta.market
    );
    directFinancialSources = directResult.results;
    allDirectUrls = directResult.allAttemptedUrls;
  } else {
    // Market mode: scrape Taiwan industry association & government stats sources directly
    logger.step('COLLECTOR', '直接抓取台灣產業統計來源（同業公會、國際貿易署）...');
    const directResult = await scrapeDirectMarketURLs(plan.topic);
    directFinancialSources = directResult.results;
    allDirectUrls = directResult.allAttemptedUrls;
  }

  // 診斷用：顯示搜尋引擎配置狀態
  logger.step('COLLECTOR', `搜尋引擎狀態: Firecrawl=${config.firecrawl.apiKey ? (firecrawlExhausted ? '額度用完' : '可用') : '未設定'} | Brave=${config.brave?.apiKey ? '可用' : '未設定'} | Google=${config.google?.cseApiKey ? '可用' : '未設定'} | Exa=${config.exa?.apiKey ? '可用' : '未設定'}`);

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

  // ── 將所有嘗試過的直連 URL 注入為 references（確保報告附錄能顯示） ──
  if (allDirectUrls.length > 0 && results.length > 0) {
    const firstQ = results[0];
    if (!firstQ.references) firstQ.references = [];
    for (const du of allDirectUrls) {
      if (!firstQ.references.some(r => r.url === du.url)) {
        let domain = '';
        try { domain = new URL(du.url).hostname; } catch {}
        firstQ.references.push({
          url: du.url,
          title: du.title || domain,
          domain,
          fetched_at: new Date().toISOString(),
        });
      }
    }
  }

  const path = saveTmp(cacheKey, results, tmpDir);
  const totalSources = results.reduce((sum, r) => sum + r.sources.length, 0);
  const totalRefs = results.reduce((sum, r) => sum + (r.references?.length || 0), 0);
  logger.info('COLLECTOR', `蒐集完成：${totalSources} 個來源 + ${totalRefs} 個參考引用 → ${path}`);

  return results;
}

// CLI 直接執行
if (process.argv[1]?.endsWith('collector.js')) {
  const plan = loadTmp('research_plan.json');
  if (!plan) { console.error('找不到 research_plan.json'); process.exit(1); }
  await runCollector(plan, { force: true });
}
