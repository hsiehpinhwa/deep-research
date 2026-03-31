export const REPORTER_SYSTEM = `你是機構等級研究報告的資深撰寫人，專為企業主管、投資人與策略分析師撰寫繁體中文深度研究報告。

## 絕對禁止編造（最高優先級）

⛔ 你 **絕對不可以** 從自身知識編造任何事實，包括但不限於：
  - 數字、百分比、金額、市佔率、排名
  - **人名、家族名稱、管理層姓名**
  - 公司持股結構、股東名單
  - 產品型號、技術規格
  - 公司歷史事件、併購紀錄
⛔ 報告中每一個具體事實聲明都必須來自「相關分析資料」中的內容。
⛔ 如果分析資料中沒有某項資訊，直接寫「截至本報告日期，公開資料尚未涵蓋此資訊」。
⛔ 不要用「據了解」「一般認為」等措辭來包裝你從訓練資料中記得的內容——你的記憶可能是錯的。

## 文體規範
1. **語氣**：客觀專業，不使用口語化表達
2. **避免**：「首先/其次/再者」連串列舉、「值得一提的是」「不得不說」等翻譯腔、「軟件/數據/獲取/協作」等簡體詞彙
3. **正確用詞**：軟體、資料、取得、協作、網路、使用者、體驗
4. **數據引用**：每個數字後必須標明來源，格式為「XX 億港幣（2024 年報）」或「市佔率 15%（Goodinfo, 2025）」
5. **段落結構**：每段以核心論點開頭，再展開論述，最後收束
6. **時效性**：今天是 2026 年 3 月。所有數據必須標明年份，不可將舊數據當作現況`;

/**
 * 骨架模式：生成 meta、摘要、章節清單（不含正文）、風險、來源
 */
export const buildReporterPrompt = (plan, analysis, mode = 'skeleton') => {
  const outline = plan.report_outline;
  const isCompany = plan.research_mode === 'company';

  const analysisText = analysis.map(a => {
    const s = a.synthesis;
    const insightLines = s.key_insights?.map(i =>
      typeof i === 'string' ? `- ${i}` : `- ${i.insight}（信心：${i.confidence}）`
    ).join('\n') || '（無）';
    const dataLines = s.data_points?.map(d =>
      typeof d === 'string' ? `- ${d}` : `- ${d.claim}（來源：${d.source_url || '未標明'}）`
    ).join('\n') || '（無）';
    const gapLines = s.gaps?.join('；') || '（無）';
    return `### ${a.question_id}：${a.question}
共識：${s.consensus?.join('；') || '（無共識）'}
洞見：\n${insightLines}
數據：\n${dataLines}
⚠️ 資料缺口：${gapLines}`;
  }).join('\n\n---\n\n');

  const companyGuidance = isCompany ? `
## 企業研究報告特殊要求
- report_type 應為「公司研究」或「競爭分析」
- 章節應涵蓋：公司概況、財務表現、競爭定位、產品與營運、SWOT 分析、投資觀點
- executive_summary 的 key_findings 只能包含有來源支撐的數據，沒有就不寫數字
- executive_summary 的 recommendations 應包含明確的投資建議或策略建議
- 研究標的：${plan.company_name || plan.topic}${plan.ticker ? `（${plan.ticker}）` : ''}
` : '';

  return `## 研究主題
${plan.topic}
${companyGuidance}
## 報告章節大綱
${outline?.sections?.map(s => `- ${s.title}`).join('\n') || '請自行設計 5 個章節'}

## 各子問題分析摘要
${analysisText}

---
⚠️ 重要提醒：
- key_findings 和 key_data 中的數字只能來自上方「數據」欄位，不可自行編造
- 若某個面向缺乏數據，在 information_gaps 中如實列出
- core_conclusion 可以做定性判斷（如「競爭力強」），但不可編造定量數字

請輸出報告骨架 JSON（不需要撰寫正文，content 欄位留空字串）：

{
  "meta": {
    "title": "報告完整標題",
    "subtitle": "副標題（含年份）",
    "report_type": "${isCompany ? '公司研究' : '產業分析'}",
    "date": "2026年3月",
    "topic": "${plan.topic}"
  },
  "executive_summary": {
    "core_conclusion": "2-3句核心結論（只用有來源的數據，沒有就做定性描述）",
    "key_findings": ["關鍵發現1（含數據來源年份）", "關鍵發現2"],
    "recommendations": ["建議行動1", "建議行動2", "建議行動3"]
  },
  "sections": [
    {
      "id": "s1",
      "title": "一、章節標題",
      "content": "",
      "key_data": ["此章節中有來源支撐的數據點"],
      "linked_questions": ["q1"],
      "section_brief": "本章節應涵蓋的核心論點（1-2句，供正文生成參考）"
    }
  ],
  "risk_and_limitations": {
    "information_gaps": ["本報告未能取得的關鍵數據1", "缺口2"],
    "key_assumptions": ["假設1", "假設2"],
    "counter_arguments": ["反面觀點1"]
  },
  "sources": []
}`;
};

/**
 * 章節正文模式：生成單一章節的完整正文
 */
export const buildSectionPrompt = (sectionDef, plan, analysis) => {
  const isCompany = plan.research_mode === 'company';

  // 找到與此章節相關的分析 — 嚴格只取 linked 的子問題
  const linked = (sectionDef.linked_questions || []);
  const relevantAnalysis = linked.length > 0
    ? analysis.filter(a => linked.includes(a.question_id)).slice(0, 3)
    : analysis.slice(0, 2); // fallback: first 2 questions for broader context

  // Build context — only data_points that haven't been used in previous sections
  const analysisContext = relevantAnalysis.length > 0
    ? relevantAnalysis.map(a => {
        const s = a.synthesis;
        const dataWithSources = s.data_points?.map(d =>
          typeof d === 'string' ? d : `${d.claim}（來源：${d.source_url || '未標明'}）`
        ).join('；') || '無';
        return `問題：${a.question}
共識：${s.consensus?.join('；') || '（無共識）'}
洞見：${s.key_insights?.map(i => typeof i === 'string' ? i : i.insight).join('；') || '無'}
有來源的數據：${dataWithSources}
⚠️ 缺口：${s.gaps?.join('；') || '無'}`;
      }).join('\n\n')
    : '（此章節無專屬來源資料，請依章節標題做定性分析）';

  const companyWritingGuide = isCompany ? `
- 財務數據章節：以表格化思維呈現（「營收 XX 億元，年增 XX%，毛利率 XX%」），數字務必標明年份與單位
- 競爭定位章節：使用波特五力或同業比較框架
- SWOT 章節：分四個小段落（優勢、劣勢、機會、威脅），每段 2-3 個要點
- 投資觀點章節：包含估值指標（PE/PB）、法人看法、風險提示` : '';

  return `## 任務
為研究報告撰寫以下章節的完整正文。

## 報告主題
${plan.topic}

## 章節資訊
標題：${sectionDef.title}
核心論點提示：${sectionDef.section_brief || '請依章節標題自行決定核心論點'}

## 相關分析資料（只能使用以下數據）
${analysisContext}

---

## 絕對禁止
⛔ 不可從 Claude 自身知識編造任何數字。上方「有來源的數據」就是你能用的全部數字。
⛔ 若某面向沒有數據，寫定性描述（如「近年穩步成長」），不要編數字。
⛔ 不可使用「據估計約 XX 億」「市場規模預計 XX」等無來源的數字。
⛔ **不可重複引用其他章節已使用的數據。** 如果某個數字（如溢利、EPS）已在前面章節出現過，本章只能簡要提及（如「如前述，2025年溢利大幅回升」），不可再次完整引用數字。每個具體數據點在全篇報告中只應完整出現一次。

## 寫作要求
請直接輸出純文字正文（非 JSON、非 markdown）：
- 長度：**1200-1800 繁體中文字**（這是專業研報的標準深度，不可偷懶寫短）
- 分為 **4-6 個段落**，每段 250-350 字
- 每段開門見山提出論點，再展開分析，最後收束
- 使用台灣商業寫作規範，避免翻譯腔
- 引用數據時標明年份與來源，如「2024 年營收達 494 億港幣（年報）」
- **本章節專注於「${sectionDef.title}」的獨特面向，避免與其他章節論述重疊**
${companyWritingGuide}

## 無數據時的處理方式
若上方「有來源的數據」為空或極少，不要寫出空洞的「公開資料尚未涵蓋」充數。改為：
1. 使用分析框架做定性推演（如波特五力、PEST、SWOT、價值鏈分析）
2. 從產業邏輯和商業常識出發，推導合理的趨勢判斷
3. 在段落開頭明確標注「基於產業邏輯的定性分析」，與有來源的數據區隔
4. 提出「後續需補充驗證的關鍵問題」作為研究建議`;
};
