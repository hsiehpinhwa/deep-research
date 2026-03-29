# DeepBrief AI — 研究流程 SOP

## 概述

本工作流程描述從使用者輸入主題到生成完整 .docx 報告的完整執行流程。

## 前置條件

- `.env` 已填入 `ANTHROPIC_API_KEY`
- （選用）填入 `FIRECRAWL_API_KEY` 和 `EXA_API_KEY` 以啟用網路蒐集

## 執行指令

```bash
# 完整流程
node src/index.js --topic "研究主題"

# 深度研究（8個子問題）
node src/index.js --topic "研究主題" --depth deep

# 強制重新執行（忽略快取）
node src/index.js --topic "研究主題" --force

# 從指定階段繼續（節省 API 費用）
node src/index.js --topic "研究主題" --resume-from reporter

# 跳過品質審稿（快速測試）
node src/index.js --topic "研究主題" --skip-review

# 獨立執行各模組
node src/modules/planner.js --topic "研究主題"
node src/modules/collector.js
node src/modules/analyzer.js
node src/modules/reporter.js
```

## 六階段流程

### 階段 1：研究規劃（planner）
- 輸入：主題字串
- 輸出：`tmp/research_plan.json`
- API 呼叫：1 次

### 階段 2：多源蒐集（collector）
- 輸入：`tmp/research_plan.json`
- 輸出：`tmp/raw_sources.json`
- 使用：Exa 搜尋 + Firecrawl 抓取
- 注意：若無 API key 則跳過，以空白來源繼續

### 階段 3：分析合成（analyzer）
- 輸入：`tmp/raw_sources.json`
- 輸出：`tmp/analysis.json`
- API 呼叫：每個子問題 1 次（共 5-8 次）

### 階段 4：報告生成（reporter）
- 輸入：`tmp/research_plan.json` + `tmp/analysis.json`
- 輸出：`tmp/report_content.json`
- API 呼叫：1-2 次

### 階段 5：品質審稿（reviewer）
- 輸入：`tmp/report_content.json`
- 輸出：更新的 report_content + `tmp/review_log.json`
- API 呼叫：每輪 1 次評分 + 修訂次數

### 階段 6：交付（deliverer）
- 輸入：最終 report_content
- 輸出：`output/*.docx`、`output/*_來源清單_*.md`

## 中間狀態

所有中間 JSON 儲存於 `tmp/`，支援從任意階段重跑：

```
tmp/
├── research_plan.json
├── raw_sources.json
├── analysis.json
├── report_content.json
├── report_content_final.json
└── review_log.json
```

## 常見問題

### API Key 未設定
若未設定 Exa/Firecrawl API key，蒐集階段會跳過網路搜尋，分析階段以空白來源繼續。

### JSON 解析失敗
Claude 偶爾在 JSON 外添加說明文字。`claude.js` 已內建 regex 萃取，若仍失敗，請查看 log 並考慮重跑。

### Token 超限
若某個子問題的來源過多，每個來源已截斷至 12,000 字元。若仍超限，可調小 `MAX_SOURCES_PER_QUESTION`。
