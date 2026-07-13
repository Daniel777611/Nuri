"""Tag each customer_msg -> agent_reply pair with a scenario category and the
conversational "move" NURI made in reply. This is the raw material for:

  - question bank      : group by scenario_category
  - decision rules      : look at agent_move patterns per scenario_category
                           (e.g. when does NURI ask a clarifying question vs.
                           give a conclusion right away?)

Input:  backend/golden_agent/processed/pairs.jsonl
Output: backend/golden_agent/processed/pairs_tagged.jsonl

Usage:
    .venv/Scripts/python.exe backend/golden_agent/tag_scenarios.py
"""
from __future__ import annotations

import json
import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

IN_PATH = os.path.join(os.path.dirname(__file__), "processed", "pairs.jsonl")
OUT_PATH = os.path.join(os.path.dirname(__file__), "processed", "pairs_tagged.jsonl")

SCENARIO_CATEGORIES = [
    "破冰_建立关系",
    "背景信息收集",
    "情绪共情_宽慰",
    "睡眠问题",
    "喂养_饮食问题",
    "行为_情绪发展问题",
    "发展里程碑咨询",
    "产品_资源推荐",
    "任务_行动建议",
    "风险预警判断",
    "闲聊_其他",
]

AGENT_MOVES = [
    "先共情",
    "追问澄清缩小判断范围",
    "给结论并解释原因",
    "推荐资源_书籍_产品",
    "确认排除风险_给安心信号",
    "生成任务_下一步行动",
    "其他",
]

_SYSTEM = f"""你是一名标注员，负责给"客户消息 -> NURI(育儿顾问AI人设)回复"的对话片段打标签。
只输出符合 schema 的 JSON，不要额外解释。

scenario_category 必须是以下之一：{SCENARIO_CATEGORIES}
agent_move 必须是以下之一：{AGENT_MOVES}（如果一条回复里做了多件事，选最主要的那个）
"""

_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "tag_pair",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "scenario_category": {"type": "string", "enum": SCENARIO_CATEGORIES},
                "agent_move": {"type": "string", "enum": AGENT_MOVES},
                "asked_clarifying_question": {"type": "boolean"},
                "gave_firm_conclusion": {"type": "boolean"},
                "rationale": {"type": "string"},
            },
            "required": [
                "scenario_category",
                "agent_move",
                "asked_clarifying_question",
                "gave_firm_conclusion",
                "rationale",
            ],
            "additionalProperties": False,
        },
    },
}


def tag_pair(client: OpenAI, pair: dict) -> dict:
    user_content = f"客户消息：\n{pair['customer_msg']}\n\nNURI回复：\n{pair['agent_reply']}"
    resp = client.chat.completions.create(
        model="gpt-5.5",
        messages=[
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": user_content},
        ],
        response_format=_SCHEMA,
    )
    return json.loads(resp.choices[0].message.content)


def main():
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY not set in .env")
    client = OpenAI(api_key=api_key)

    with open(IN_PATH, encoding="utf-8") as fh:
        pairs = [json.loads(line) for line in fh]

    tagged = []
    for i, pair in enumerate(pairs, 1):
        print(f"tagging {i}/{len(pairs)} ({pair['source_file']}) ...")
        try:
            tags = tag_pair(client, pair)
        except Exception as e:
            print(f"  [error] {type(e).__name__}: {e}")
            tags = {
                "scenario_category": "闲聊_其他",
                "agent_move": "其他",
                "asked_clarifying_question": False,
                "gave_firm_conclusion": False,
                "rationale": f"tagging failed: {e}",
            }
        tagged.append({**pair, **tags})

    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        for row in tagged:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    from collections import Counter

    cat_counts = Counter(r["scenario_category"] for r in tagged)
    move_counts = Counter(r["agent_move"] for r in tagged)
    print(f"\nwrote {len(tagged)} tagged pairs -> {OUT_PATH}")
    print("\nscenario_category counts:")
    for cat, n in cat_counts.most_common():
        print(f"  {cat}: {n}")
    print("\nagent_move counts:")
    for mv, n in move_counts.most_common():
        print(f"  {mv}: {n}")


if __name__ == "__main__":
    main()
