// server/mailer.js
import { Resend } from 'resend';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

// Lazy init: avoid throwing at module load when RESEND_API_KEY is not yet set
let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}
const FROM = process.env.RESEND_FROM || 'DeepBrief AI <research@deepbrief.ai>';

export async function sendReportEmail({ email, topic, docxPath, summaryPath }) {
  const attachments = [];

  if (docxPath && existsSync(docxPath)) {
    attachments.push({
      filename: basename(docxPath),
      content:  readFileSync(docxPath).toString('base64'),
    });
  }
  if (summaryPath && existsSync(summaryPath)) {
    attachments.push({
      filename: basename(summaryPath),
      content:  readFileSync(summaryPath).toString('base64'),
    });
  }

  return getResend().emails.send({
    from: FROM,
    to:   [email],
    subject: `[DeepBrief] 「${topic}」研究報告已完成`,
    html: buildEmailHtml(topic),
    attachments,
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmailHtml(topic) {
  const safeText = escapeHtml(String(topic).slice(0, 100));
  return [
    '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">',
    '<div style="background:#001A4E;color:#fff;padding:24px 32px;border-radius:8px 8px 0 0">',
    '<h1 style="margin:0;font-size:20px">DeepBrief AI</h1>',
    '</div>',
    '<div style="border:1px solid #e5e7eb;border-top:none;padding:32px;border-radius:0 0 8px 8px">',
    '<h2 style="color:#001A4E;margin-top:0">研究報告完成通知</h2>',
    '<p>您委託的研究主題「<strong>' + safeText + '</strong>」已完成。</p>',
    '<p>完整報告與摘要卡已附於此封信件，請查收附件。</p>',
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">',
    '<p style="color:#6b7280;font-size:13px">此信由 DeepBrief AI 自動寄出。</p>',
    '</div>',
    '</div>',
  ].join('');
}
