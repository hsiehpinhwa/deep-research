#!/usr/bin/env python3
"""
DeepBrief AI — CJK 品質掃描器
掃描文件中的簡繁混用、形近字錯誤
"""
import json
import re
import sys
from pathlib import Path

# 簡體字詞黑名單（含建議替換）
SIMPLIFIED_BLACKLIST = {
    # 繁簡有實質差異的詞（只列繁簡字形不同、且台灣慣用繁體的詞）
    '软件': '軟體',
    '硬件': '硬體',
    '数据': '資料',
    '获取': '取得',
    '协作': '協作',      # 簡體：协作
    '体验': '體驗',      # 簡體：体验
    '网络': '網路',      # 簡體：网络
    '网站': '網站',      # 簡體：网站
    '用户': '使用者',
    '开发': '開發',
    '发展': '發展',
    '发现': '發現',
    '发布': '發布',
    '实现': '實現',
    '实际': '實際',
    '实施': '實施',
    '应该': '應該',
    '进行': '進行',
    '进入': '進入',
    '进一步': '進一步',
    '区块链': '區塊鏈',
    '云计算': '雲端運算',
    '人工智能': '人工智慧',
    '机器学习': '機器學習',
    '深度学习': '深度學習',
    '设备': '設備',
    '设计': '設計',
    '处理': '處理',
    '处于': '處於',
    '对于': '對於',
    '关注': '關注',
    '关键': '關鍵',
    '关系': '關係',
    '报告': '報告',
    '报道': '報導',
    '竞争': '競爭',
    '竞争对手': '競爭對手',
    '优势': '優勢',
    '优化': '優化',
    '战略': '戰略',
    '规模': '規模',
    '规划': '規劃',
    '总结': '總結',
    '联系': '聯繫',
    '联合': '聯合',
    '财务': '財務',
    '经济': '經濟',
    '经营': '經營',
    '增长': '成長',
    '显示': '顯示',
    '显著': '顯著',
    '维护': '維護',
    '维持': '維持',
    '供应链': '供應鏈',
    '运营': '營運',
    '销售': '銷售',
    '消费者': '消費者',
    '研发': '研發',
    '技术': '技術',
    '创新': '創新',
    '创业': '創業',
    '创造': '創造',
    '计划': '計畫',
    '预测': '預測',
    '预期': '預期',
    '预算': '預算',
    '这个': '這個',
    '这些': '這些',
    '来自': '來自',
    '来源': '來源',
    '带来': '帶來',
    '带动': '帶動',
    '时间': '時間',
    '时期': '時期',
    '趋势': '趨勢',
    '潜力': '潛力',
    '潜在': '潛在',
    '资本': '資本',
    '资源': '資源',
    '资产': '資產',
    '融资': '融資',
    '并购': '併購',
    '领域': '領域',
    '领先': '領先',
    '转变': '轉變',
    '转型': '轉型',
    # 注意：以下詞在繁簡中文相同，不列入（避免誤報）：
    # 需求、政策、政府、平台、那、市場、服務、企業、業務、系統、整體
}

# 高風險形近字對（正確→錯誤）
CONFUSABLE_CHARS = {
    '台灣': ['台湾'],
    '億': ['亿'],
    '與': ['与'],
    '無': ['无'],
    '為': ['为'],
    '該': ['该'],
    '並': ['并'],
    '從': ['从'],
    '後': ['后'],
    '裡': ['里'],
    '裏': [],
    '歲': ['岁'],
    '萬': ['万'],
    '當': ['当'],
    '現': ['现'],
    '還': ['还'],
    '過': ['过'],
    '說': ['说'],
    '國': ['国'],
    '們': ['们'],
    '會': ['会'],
    '來': ['来'],
    '長': ['长'],
    '種': ['种'],
    '體': ['体'],
    # '製': ['制'],  # 移除：制 在「管制/限制/制定/制約」等詞中是正確繁體，不可替換為製
    '變': ['变'],
    '東': ['东'],
    '問': ['问'],
    '間': ['间'],
    '見': ['见'],
    '個': ['个'],
    '樣': ['样'],
    '號': ['号'],
    '員': ['员'],
    '際': ['际'],
    '務': ['务'],
    '節': ['节'],
    '術': ['术'],
}


def scan_content(text: str) -> list[dict]:
    """掃描文字，回傳所有違規項目"""
    violations = []

    # 掃描簡體字詞
    for simplified, traditional in SIMPLIFIED_BLACKLIST.items():
        matches = [(m.start(), m.end()) for m in re.finditer(re.escape(simplified), text)]
        for start, end in matches:
            context = text[max(0, start-20):min(len(text), end+20)]
            violations.append({
                'type': 'simplified_word',
                'found': simplified,
                'suggestion': traditional,
                'position': start,
                'context': f'...{context}...',
            })

    # 掃描形近字
    for correct, wrong_list in CONFUSABLE_CHARS.items():
        for wrong in wrong_list:
            matches = [(m.start(), m.end()) for m in re.finditer(re.escape(wrong), text)]
            for start, end in matches:
                context = text[max(0, start-20):min(len(text), end+20)]
                violations.append({
                    'type': 'confusable_char',
                    'found': wrong,
                    'suggestion': correct,
                    'position': start,
                    'context': f'...{context}...',
                })

    return violations


def scan_report_json(report_content: dict) -> dict:
    """掃描整份報告 JSON 中的所有文字欄位"""
    all_violations = []

    def extract_text(obj, path=''):
        if isinstance(obj, str):
            violations = scan_content(obj)
            for v in violations:
                v['field_path'] = path
            all_violations.extend(violations)
        elif isinstance(obj, dict):
            for k, v in obj.items():
                extract_text(v, f'{path}.{k}' if path else k)
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                extract_text(item, f'{path}[{i}]')

    extract_text(report_content)

    return {
        'total_violations': len(all_violations),
        'passed': len(all_violations) == 0,
        'violations': all_violations[:50],  # 最多回傳 50 個
    }


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='DeepBrief CJK 品質掃描器')
    parser.add_argument('--input', required=True, help='report_content.json 路徑')
    args = parser.parse_args()

    with open(args.input, 'r', encoding='utf-8') as f:
        content = json.load(f)

    result = scan_report_json(content)

    if result['passed']:
        print('[CJK SCANNER] ✓ 通過，無簡繁混用或形近字問題')
    else:
        print(f'[CJK SCANNER] ✗ 發現 {result["total_violations"]} 個問題：')
        for v in result['violations']:
            print(f'  [{v["type"]}] 「{v["found"]}」→「{v["suggestion"]}」')
            print(f'    路徑：{v["field_path"]}')
            print(f'    上下文：{v["context"]}')

    print(json.dumps(result, ensure_ascii=False, indent=2))
