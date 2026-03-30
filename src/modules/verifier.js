import { callClaudeJSON } from '../utils/claude.js';
import { saveTmp } from '../utils/fileUtils.js';
import { logger } from '../utils/logger.js';
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
 * Replace unverified claims in section content.
 * Removes sentences containing unverified numbers.
 */
function cleanUnverifiedClaims(content, claims) {
  let cleaned = content;
  const unverified = claims.filter(c => c.status === 'unverified');

  for (const claim of unverified) {
    if (!claim.text) continue;
    // Try to find and replace the exact sentence
    const escaped = claim.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    if (regex.test(cleaned)) {
      cleaned = cleaned.replace(regex, '（此數據未獲來源驗證，已移除）');
      logger.warn('VERIFIER', `  移除未驗證聲明: ${claim.text.slice(0, 50)}...`);
    }
  }

  return cleaned;
}

/**
 * Verify a single section's numerical claims against sources.
 */
async function verifySection(section, analysis, rawSources) {
  if (!section.content || section.content.length < 50) {
    return { section, verification: null };
  }

  const { dataPoints, sourceSnippets } = gatherContext(section, analysis, rawSources);

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

    // Clean unverified claims from section content
    if (summary.unverified > 0) {
      section.content = cleanUnverifiedClaims(section.content, claims);
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
