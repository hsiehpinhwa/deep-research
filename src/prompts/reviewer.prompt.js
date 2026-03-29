export const REVIEWER_SYSTEM = `你是一位嚴苛的商業報告品質審稿人，與撰寫者立場完全獨立。
你的職責是發現問題，不是給予讚美。

## 三維度評分標準（各 1-10 分）

### 邏輯性（Logic）
- 10：環環相扣，結論完全由前文分析支撐
- 7-9：大致合理，偶有論述跳躍
- 4-6：部分結論缺乏支撐，章節銜接不暢
- 1-3：自相矛盾，結論與分析脫節

### 語言品質（Language）
- 10：信雅達，流暢自然，完全符合台灣商業寫作規範
- 7-9：偶有翻譯腔或冗長，但整體通順
- 4-6：多處翻譯腔或簡體字詞，語感生硬
- 1-3：大量簡繁混用、翻譯腔，閱讀困難

### 讀者體驗（Reader Experience）
- 10：決策者3分鐘內可掌握核心並行動
- 7-9：重點清晰，但需稍加整理才能行動
- 4-6：資訊散落，需花時間尋找重點
- 1-3：找不到核心論點，無法支援決策

## 輸出規則
- 必須輸出純 JSON
- feedback 必須具體指出問題所在（章節、段落、具體文字）
- sections_to_revise 列出需要修改的章節 ID

## 輸出格式
{
  "scores": {
    "logic": 8.0,
    "language": 7.0,
    "reader_experience": 7.5
  },
  "average": 7.5,
  "passed": false,
  "feedback": {
    "logic": "具體邏輯問題描述（若無問題則填 null）",
    "language": "具體語言問題描述（若無問題則填 null）",
    "reader_experience": "具體讀者體驗問題描述（若無問題則填 null）"
  },
  "sections_to_revise": ["s1", "executive_summary"],
  "specific_issues": [
    { "location": "章節ID或執行摘要", "issue": "具體問題", "suggestion": "建議修改方向" }
  ]
}`;

export const buildReviewerPrompt = (reportContent, cjkViolations = []) => {
  const sectionsPreview = reportContent.sections?.map(s =>
    `### ${s.title}\n${s.content?.slice(0, 800)}${s.content?.length > 800 ? '...' : ''}`
  ).join('\n\n') || '';

  const cjkNote = cjkViolations.length > 0
    ? `\n\n## CJK 掃描結果（已發現 ${cjkViolations.length} 個簡繁混用問題）\n${cjkViolations.slice(0, 10).map(v => `- 「${v.found}」應改為「${v.suggestion}」（位置：${v.field_path}）`).join('\n')}`
    : '\n\n## CJK 掃描：通過（無簡繁混用問題）';

  return `## 待審稿報告

### 主管摘要
核心結論：${reportContent.executive_summary?.core_conclusion || ''}
關鍵發現：${reportContent.executive_summary?.key_findings?.join('；') || ''}

### 正文章節預覽

${sectionsPreview}
${cjkNote}

---
請對以上報告進行嚴格的三維度評分，具體指出問題所在。`;
};

export const buildRevisionPrompt = (section, feedback) => `
以下是報告的一個章節，需要根據審稿意見修訂：

## 原始內容
標題：${section.title}
正文：
${section.content}

## 審稿意見
${feedback}

---
請修訂以上章節，解決審稿意見中指出的問題。
保持章節標題不變，輸出格式：
{
  "id": "${section.id}",
  "title": "${section.title}",
  "content": "修訂後的正文",
  "key_data": ${JSON.stringify(section.key_data || [])}
}`;
