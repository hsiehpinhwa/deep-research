# Research Type Auto-Detection & Company Research Mode

## Goal

Make Dolphin.Ai automatically detect whether a topic is "market research" or "company research", and use specialized prompts/search strategies for each type. No new dependencies or architecture changes.

## Research Types

### Market Research (default, existing behavior — minor refinement)

**Trigger:** Topic describes an industry, market, or trend without focusing on a specific company.
Examples: "台灣寵物學校市場", "2025 植物奶市場趨勢"

**Angles:** 市場數據、競爭格局、政策法規、技術產品、消費者需求、財務投資、未來展望

**Collector:** Current behavior (Firecrawl + Exa web search)

**Analyzer:** Current behavior (cross-source validation)

### Company Research (new)

**Trigger:** Topic mentions a specific company name, brand, or ticker symbol.
Examples: "路易莎咖啡營運分析", "統一超商 vs 全聯", "騰訊 2024 年報解讀"

**Angles (6):**
1. 財務表現 — 營收、獲利、成長率、現金流
2. 競爭定位 — 市佔率、定價策略、差異化優勢
3. 管理層與股權 — 經營團隊、大股東結構、治理品質
4. 產品與營運 — 產品線、展店/擴張、供應鏈
5. SWOT 綜合 — 優勢、劣勢、機會、威脅
6. 估值與投資觀點 — PE/PB、法人看法、未來展望

**Collector — targeted search strategy:**
- Taiwan companies: append `site:goodinfo.tw OR site:mops.twse.com.tw OR site:moneydj.com OR site:money.udn.com` to search queries
- HK companies: append `site:aastocks.com OR site:hkexnews.hk OR site:finance.now.com`
- General: `site:cnyes.com OR site:cw.com.tw` for both markets
- The planner output will include a `market` field ("tw" | "hk" | "general") to guide collector

**Analyzer — company-specific framework:**
- Uses Porter's Five Forces lens for competitive analysis
- Financial trend interpretation (YoY growth, margin analysis)
- SWOT matrix synthesis
- Confidence scoring same as current (high/medium/low)

**Reporter — company report structure:**
- Section prompt includes guidance to write financial data as tables where appropriate
- SWOT section prompted to use matrix format

## Detection Mechanism

The planner system prompt will instruct Claude to:
1. Read the topic
2. Output `"research_mode": "market"` or `"research_mode": "company"` in the JSON
3. If company mode, also output `"company_name"`, `"market"` (tw/hk/general), and `"ticker"` (if identifiable)

This is a single Claude call — no extra API cost. The classification happens as part of the existing planner call.

## Files Changed

| File | Change |
|------|--------|
| `src/prompts/planner.prompt.js` | Add research_mode detection + company research angles/format |
| `src/modules/collector.js` | Read `plan.research_mode` and `plan.market`; append site-specific search operators |
| `src/prompts/analyzer.prompt.js` | Add company research system prompt variant |
| `src/prompts/reporter.prompt.js` | Add company research section writing guidance |

## What's NOT Changing

- Pipeline architecture (planner → collector → analyzer → reporter → reviewer → deliverer)
- Module interfaces (same function signatures)
- Redis job state
- Frontend UI
- No new npm dependencies
- No new API keys
