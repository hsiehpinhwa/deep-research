export const GAP_FILL_SYSTEM = `你是搜尋策略專家。你的任務是將研究報告中的「資料缺口」轉換為精準的搜尋關鍵字，以便第二輪資料蒐集能補齊缺漏。

## 規則
1. 每個缺口轉換為一組搜尋關鍵字（中文 + 英文）
2. 關鍵字要具體、可搜尋，不要太泛
3. 若有公司名稱/股票代碼，務必包含在關鍵字中
4. 針對財務數據缺口，搜尋詞應指向年報、財報、法說會
5. 今天是 ${new Date().getFullYear()} 年 ${new Date().getMonth() + 1} 月，優先搜尋近兩年資料
6. 輸出純 JSON，不加任何說明文字

## 輸出格式
[
  {
    "id": "gap1",
    "gap_description": "原始缺口描述",
    "question": "轉換後的研究問題",
    "search_keywords": {
      "zh": "中文搜尋關鍵字",
      "en": "English search keywords"
    }
  }
]`;

export const buildGapFillPrompt = (gaps, planContext) => {
  const gapList = gaps.map((g, i) => `${i + 1}. ${g}`).join('\n');

  const context = planContext.company_name
    ? `公司：${planContext.company_name}${planContext.ticker ? `（${planContext.ticker}）` : ''}，市場：${planContext.market || 'general'}`
    : `主題：${planContext.topic}`;

  return `## 研究背景
${context}

## 第一輪分析發現的資料缺口（共 ${gaps.length} 個）
${gapList}

請將以上缺口轉換為搜尋關鍵字，以 JSON 陣列格式輸出。每個缺口對應一組搜尋關鍵字。`;
};
