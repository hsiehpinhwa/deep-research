export const REPORTER_SYSTEM = `你是機構等級研究報告的資深撰寫人，專為企業主管、投資人與策略分析師撰寫繁體中文深度研究報告。

## 文體規範
1. **語氣**：客觀專業，不使用口語化表達
2. **避免**：「首先/其次/再者」連串列舉、「值得一提的是」「不得不說」等翻譯腔、「軟件/數據/獲取/協作」等簡體詞彙
3. **正確用詞**：軟體、資料、取得、協作、網路、使用者、體驗
4. **數據引用**：在行文中自然嵌入來源（「根據XX研究顯示」「依據YY統計」）
5. **段落結構**：每段以核心論點開頭，再展開論述，最後收束`;

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
      typeof d === 'string' ? `- ${d}` : `- ${d.claim}`
    ).join('\n') || '（無）';
    return `### ${a.question_id}：${a.question}
共識：${s.consensus?.join('；') || '（無，請依 Claude 知識填充）'}
洞見：\n${insightLines}
數據：\n${dataLines}
缺口：${s.gaps?.join('；') || '（無）'}`;
  }).join('\n\n---\n\n');

  const companyGuidance = isCompany ? `
## 企業研究報告特殊要求
- report_type 應為「公司研究」或「競爭分析」
- 章節應涵蓋：公司概況、財務表現、競爭定位、產品與營運、SWOT 分析、投資觀點
- executive_summary 的 key_findings 應包含至少一條財務數據（營收/獲利/成長率）
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
    "core_conclusion": "2-3句核心結論（依 Claude 知識撰寫）",
    "key_findings": ["關鍵發現1", "關鍵發現2", "關鍵發現3", "關鍵發現4", "關鍵發現5"],
    "recommendations": ["建議行動1", "建議行動2", "建議行動3"]
  },
  "sections": [
    {
      "id": "s1",
      "title": "一、章節標題",
      "content": "",
      "key_data": ["此章節的重要數據點1", "重要數據點2"],
      "linked_questions": ["q1"],
      "section_brief": "本章節應涵蓋的核心論點（1-2句，供正文生成參考）"
    }
  ],
  "risk_and_limitations": {
    "information_gaps": ["缺口1", "缺口2"],
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

  // 找到與此章節相關的分析
  const linked = (sectionDef.linked_questions || []);
  const relevantAnalysis = analysis
    .filter(a => linked.includes(a.question_id) || linked.length === 0)
    .slice(0, 3);

  const analysisContext = relevantAnalysis.length > 0
    ? relevantAnalysis.map(a => {
        const s = a.synthesis;
        return `問題：${a.question}
共識：${s.consensus?.join('；') || '無（請依 Claude 知識填充）'}
洞見：${s.key_insights?.map(i => typeof i === 'string' ? i : i.insight).join('；') || '無'}
數據：${s.data_points?.map(d => typeof d === 'string' ? d : d.claim).join('；') || '無'}`;
      }).join('\n\n')
    : '（無來源資料，請依 Claude 的知識撰寫）';

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

## 相關分析資料
${analysisContext}

---
請直接輸出純文字正文（非 JSON、非 markdown）：
- 長度：600-900 繁體中文字
- 分為 3-4 個段落，每段 150-250 字
- 每段開門見山提出論點，再展開分析
- 使用台灣商業寫作規範，避免翻譯腔
- 若無來源資料，依 Claude 的知識撰寫，不要說「根據分析」或「依據資料」等空話${companyWritingGuide}`;
};
