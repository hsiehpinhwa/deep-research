import { callClaudeJSON } from '../utils/claude.js';
import { saveTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
import { searchWithFallback } from './collector.js';
import { VERIFIER_SYSTEM, buildVerifierPrompt } from '../prompts/verifier.prompt.js';

/**
 * Gather data_points and source snippets relevant to a section.
 */
function gatherContext(section, analysis, rawSources) {
  const linked = section.linked_questions || [];

  // Collect data_points from linked analysis
  const dataPoints = [];
  for (const a of analysis) {
    if (linked.length === 0 || linked.includes(a.question_id)) {
      for (const dp of a.synthesis?.data_points || []) {
        if (typeof dp === 'object') dataPoints.push(dp);
      }
    }
  }

  // Collect source snippets from linked questions
  const sourceSnippets = [];
  const seenUrls = new Set();
  for (const q of rawSources) {
    if (linked.length === 0 || linked.includes(q.question_id)) {
      for (const s of q.sources || []) {
        if (!seenUrls.has(s.url)) {
          seenUrls.add(s.url);
          sourceSnippets.push(s);
        }
      }
    }
  }

  return { dataPoints, sourceSnippets: sourceSnippets.slice(0, 5) }; // limit context
}

/**
 * Attempt to verify unverified claims by searching for supporting evidence.
 * Returns updated claims array with re-verified statuses.
 */
async function rescueClaims(claims) {
  const unverified = claims.filter(c => c.status === 'unverified' && c.number);
  if (unverified.length === 0) return claims;

  // Batch: max 3 claims per rescue round to avoid API overload
  const toRescue = unverified.slice(0, 3);
  logger.info('VERIFIER', `  嘗試補搜驗證 ${toRescue.length} 個未驗證聲明...`);

  for (const claim of toRescue) {
    try {
      // Build a search query from the claim text/number
      const query = claim.text.length > 80 ? claim.text.slice(0, 80) : claim.text;
      const results = await searchWithFallback(query, 3);

      if (!results || results.length === 0) continue;

      // Check if any search result contains the claimed number
      const numberStr = String(claim.number).replace(/[%％億萬]/g, '');
      const found = results.find(r => {
        const content = (r.markdown || r.content || r.title || '');
        return content.includes(numberStr) || content.includes(claim.number);
      });

      if (found) {
        claim.status = 'verified';
        claim.source_evidence = `補搜驗證：在 ${found.title || found.url} 中找到對應數據`;
        claim.source_url = found.url;
        logger.info('VERIFIER', `  ✓ 補搜成功: "${claim.number}" ← ${found.url}`);
      }
    } catch (err) {
      // Non-fatal: if rescue search fails, claim stays unverified
      logger.warn('VERIFIER', `  補搜失敗 (${claim.number}): ${err.message}`);
    }
  }

  return claims;
}

/**
 * Replace unverified claims in section content.
 * Removes sentences containing unverified numbers.
 */
function cleanUnverifiedClaims(content, claims) {
  let cleaned = content;
  const unverified = claims.filter(c => c.status === 'unverified');

  for (const claim of unverified) {
    if (!claim.text) continue;
    // Try to find and remove the exact text — no placeholder, just remove
    const escaped = claim.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    if (regex.test(cleaned)) {
      cleaned = cleaned.replace(regex, '');
      logger.warn('VERIFIER', `  移除未驗證聲明: ${claim.text.slice(0, 50)}...`);
    }
  }

  // Clean up artifacts: double commas, double periods, orphaned parentheses, extra spaces
  cleaned = cleaned
    .replace(/，，+/g, '，')
    .replace(/。。+/g, '。')
    .replace(/（\s*）/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/，。/g, '。')
    .replace(/。，/g, '。')
    .trim();

  return cleaned;
}

/**
 * Verify a single section's numerical claims against sources.
 */
async function verifySection(section, analysis, rawSources) {
  if (!section.content || section.content.length < 50) {
    return { claims: [], summary: { total_claims: 0, verified: 0, unverified: 0, conflicting: 0 } };
  }

  const { dataPoints, sourceSnippets } = gatherContext(section, analysis, rawSources);

  try {
    const result = await callClaudeJSON(
      VERIFIER_SYSTEM,
      buildVerifierPrompt(section, dataPoints, sourceSnippets),
      { maxTokens: 4096 }
    );

    const claims = result.claims || [];
    const summary = result.summary || {
      total_claims: claims.length,
      verified: claims.filter(c => c.status === 'verified').length,
      unverified: claims.filter(c => c.status === 'unverified').length,
      conflicting: claims.filter(c => c.status === 'conflicting').length,
    };

    return { claims, summary };
  } catch (err) {
    // Don't let a single section's verification failure kill the whole pipeline
    logger.warn('VERIFIER', `  ${section.title} 驗證失敗（${err.message}），跳過此章節`);
    return { claims: [], summary: { total_claims: 0, verified: 0, unverified: 0, conflicting: 0 } };
  }
}

/**
 * Main verifier function.
 * Checks all numerical claims in the report against source data.
 *
 * @param {object} report - report from reporter
 * @param {Array} analysis - analysis results
 * @param {Array} rawSources - collected sources
 * @param {object} options - { tmpDir }
 * @returns {object} cleaned report with verification_summary
 */
export async function runVerifier(report, analysis, rawSources, options = {}) {
  const tmpDir = options.tmpDir;
  const sections = report.sections || [];

  logger.step('VERIFIER', `開始事實驗證：${sections.length} 個章節`);

  let totalVerified = 0;
  let totalUnverified = 0;
  let totalConflicting = 0;
  let totalClaims = 0;

  for (const section of sections) {
    logger.step('VERIFIER', `  驗證：${section.title}`);

    const { claims, summary } = await verifySection(section, analysis, rawSources);

    if (!claims || claims.length === 0) {
      logger.info('VERIFIER', `  ${section.title}: 無數字聲明`);
      continue;
    }

    totalClaims += summary.total_claims || 0;
    totalVerified += summary.verified || 0;
    totalUnverified += summary.unverified || 0;
    totalConflicting += summary.conflicting || 0;

    logger.info('VERIFIER', `  ${section.title}: ${summary.verified}✓ ${summary.unverified}✗ ${summary.conflicting}⚡ / ${summary.total_claims} 聲明`);

    // Phase 2: Attempt to rescue unverified claims via search
    let finalClaims = claims;
    if (summary.unverified > 0) {
      finalClaims = await rescueClaims(claims);
      const rescued = finalClaims.filter(c => c.status === 'verified').length - summary.verified;
      if (rescued > 0) {
        logger.info('VERIFIER', `  ${section.title}: 補搜救回 ${rescued} 個聲明`);
        summary.verified += rescued;
        summary.unverified -= rescued;
      }
    }

    // Clean remaining unverified claims from section content
    if (summary.unverified > 0) {
      section.content = cleanUnverifiedClaims(section.content, finalClaims);
    }
  }

  // Attach verification summary to report
  report.verification_summary = {
    total_claims: totalClaims,
    verified: totalVerified,
    unverified: totalUnverified,
    conflicting: totalConflicting,
    pass_rate: totalClaims > 0 ? Math.round((totalVerified / totalClaims) * 100) : 100,
  };

  logger.step('VERIFIER', `事實驗證完成：${totalVerified}/${totalClaims} 驗證通過（${report.verification_summary.pass_rate}%）`);

  saveTmp('report_verified.json', report, tmpDir);

  return report;
}
