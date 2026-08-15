"""Does NURI stay the same assistant across a conversation?

The variance eval asks one question many times. This one asks many questions
once, in order, feeding each reply back as history — which is the only way the
four multi-turn failures can happen at all:

    改口      a fact the parent established is quietly replaced later
    遗忘      a fact falls out of the history window and is gone
    自相矛盾  the same question, asked twice, gets opposite advice
    人格漂移  turn 12 is written by a different assistant than turn 2

Three of those four need no judge, which is most of why this is worth building.
改口 and 遗忘 are checkable with a regex, because the fixture plants the fact
and therefore knows it. 人格漂移 is the variance eval's surface metrics read
against turn index. Only 自相矛盾 needs a model, and the question put to it is
binary and narrow — "do these two answers conflict" — not "which is better".

Two arms, because "the parent said it fifteen turns ago" has two different
fixes and they fail differently:

    window   the history window alone
    memory   the same conversation with the memory block the extractor is
             supposed to have produced, rendered exactly as family_store does

If a fact is lost in `window` and recovered in `memory`, the window is doing its
job and the extractor is what matters. If it is lost in both, the reply model
ignores the memory block it is handed, and no amount of extraction will help.

`--window` is small by default on purpose: the window size is a parameter, so a
twelve-turn conversation against a window of six exercises the same "it fell out
of the window" path as a thirty-five-turn conversation against the real twenty,
at a third of the cost. The failure is structural, not a function of turn count.

    .venv/Scripts/python.exe backend/evals/coherence.py
    .venv/Scripts/python.exe backend/evals/coherence.py --arms memory --window 20
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from backend import llm_usage                                  # noqa: E402
from backend.evals.variance import score                       # noqa: E402
from backend.nuri_core.dialogue_reply import nuri_reply_sync   # noqa: E402
from backend.runtime import oai                                # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")

#: Rendered the way family_store.get_memory_context does — grouped by the
#: category labels, one line each. A block in any other shape would test a
#: prompt the app never actually builds.
CONVERSATIONS: tuple[dict, ...] = (
    {
        "id": "solids-age",
        "memory": "孩子当前状态：宝宝刚满四个月，吐舌反射还明显\n家庭偏好：全母奶为主，最近加一餐配方奶",
        "turns": (
            {"say": "我家寶寶剛滿四個月，想開始吃副食品，他會把米糊吐出來"},
            {"say": "我是全母奶，最近才加一餐配方奶"},
            {"say": "他晚上大概睡六個小時"},
            {"say": "白天小睡都很短，大概三十分鐘"},
            {"say": "最近開始會翻身了"},
            {"say": "婆婆一直說要趕快加副食品"},
            {"say": "我九月可能要送托嬰"},
            # By here the first two turns are outside a window of six.
            {
                "say": "那你覺得他現在一天可以吃幾餐副食品？",
                "probe": "改口",
                "forbid": r"[一二三兩两1-9]\s*[歲岁]|幼[兒儿][園园]|上小[學学]",
                "why": "月龄是第 1 轮定下的，回到「几岁」就是把家长说过的事换掉了",
            },
            {"say": "我還在猶豫要不要換品牌"},
            {
                "say": "你還記得他平常是喝母奶還是配方奶嗎？",
                "probe": "遗忘",
                "require": r"母[奶乳]",
                "why": "第 2 轮说过全母奶，此时已在窗口外，只能靠记忆块",
            },
        ),
    },
    {
        "id": "assessment-flipflop",
        "memory": "孩子当前状态：两岁半，主要还是两三个字的表达\n家长关注点：在犹豫要不要做语言评估",
        "turns": (
            {"say": "孩子兩歲半，講話還是只有兩三個字"},
            {
                "say": "要不要現在就去做語言評估？",
                "probe": "自相矛盾",
                "pair": "assessment",
                "why": "同一个问题问两次，中间隔着闲聊",
            },
            {"say": "他最近很喜歡玩車子"},
            {"say": "也很愛看繪本，但一下就跑掉"},
            {"say": "我們家平常講國語，阿公阿嬤講台語"},
            {"say": "他聽得懂指令，叫他拿鞋子會拿"},
            {"say": "最近開始會指東西給我看"},
            {
                "say": "所以我到底該不該帶他去做評估？",
                "probe": "自相矛盾",
                "pair": "assessment",
                "why": "中间的信息都是正面的，但结论不该整个翻面",
            },
        ),
    },
)

JUDGE_MODEL = "gpt-5.4-mini"
JUDGE_SYSTEM = (
    "你在检查一个育儿顾问 AI 在同一段对话里是否自相矛盾。会给你它对同一个问题"
    "前后两次的回答。只判断一件事：两次的**结论或建议方向**是否互相冲突，"
    "例如一次说「建议现在就去评估」另一次说「先不用急着评估」。\n\n"
    "不算矛盾的情况：措辞不同、详略不同、后一次因为拿到新信息而补充了条件或细节、"
    "语气不同。只有当家长照着做会得到相反行动时，才算矛盾。"
)


def judge(first: str, second: str) -> dict:
    if not oai:
        return {"contradiction": None, "reason": "no client"}
    try:
        resp = oai.chat.completions.create(
            model=JUDGE_MODEL,
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM},
                {"role": "user", "content": f"第一次回答：\n{first}\n\n第二次回答：\n{second}"},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "contradiction", "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "contradiction": {"type": "boolean"},
                            "reason": {"type": "string"},
                        },
                        "required": ["contradiction", "reason"],
                        "additionalProperties": False,
                    },
                },
            },
        )
        llm_usage.record("eval.coherence_judge", JUDGE_MODEL,
                         usage=getattr(resp, "usage", None))
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        print(f"[warn] judge failed: {type(e).__name__}: {e}")
        return {"contradiction": None, "reason": f"{type(e).__name__}"}


def run_conversation(convo: dict, arm: str, window: int) -> dict:
    history: list[dict] = []
    memory_ctx = convo["memory"] if arm == "memory" else ""
    turns = []
    for i, turn in enumerate(convo["turns"], 1):
        history.append({"role": "user", "text": turn["say"]})
        print(f"  {convo['id']:<22} {arm:>6}  turn {i}/{len(convo['turns'])}", flush=True)
        reply = nuri_reply_sync(history, "", memory_ctx, history_window=window)
        text = reply.get("text") or ""
        history.append({"role": "ai", "text": text})

        record = {"n": i, "say": turn["say"], "text": text, **score(reply)}
        if turn.get("probe"):
            record["probe"] = turn["probe"]
            record["why"] = turn.get("why", "")
            record["pair"] = turn.get("pair")
            if turn.get("require"):
                hit = bool(re.search(turn["require"], text))
                record["pass"] = hit
                record["detail"] = "找到了" if hit else f"没有出现 /{turn['require']}/"
            elif turn.get("forbid"):
                bad = re.search(turn["forbid"], text)
                record["pass"] = not bad
                record["detail"] = f"出现了「{bad.group(0)}」" if bad else "没有跑掉"
        turns.append(record)

    # Contradiction probes are scored in pairs, after both halves exist.
    by_pair: dict[str, list[dict]] = {}
    for t in turns:
        if t.get("pair"):
            by_pair.setdefault(t["pair"], []).append(t)
    for pair, members in by_pair.items():
        if len(members) < 2:
            continue
        verdict = judge(members[0]["text"], members[-1]["text"])
        for m in members:
            m["pass"] = verdict.get("contradiction") is False
            m["detail"] = verdict.get("reason", "")[:160]

    return {"id": convo["id"], "arm": arm, "turns": turns}


def drift(turns: list[dict]) -> dict:
    """人格漂移: is the back half of the conversation written like the front?"""
    half = max(1, len(turns) // 2)
    front, back = turns[:half], turns[half:]
    out = {}
    for m in ("chars", "list_items", "bold"):
        f = sum(t[m] for t in front) / len(front)
        b = sum(t[m] for t in back) / len(back)
        out[m] = (round(f, 1), round(b, 1))
    return out


def report(runs: list[dict]) -> bool:
    print("\n" + "=" * 88)
    print("PROBES")
    print("=" * 88)
    all_ok = True
    for r in runs:
        probes = [t for t in r["turns"] if t.get("probe")]
        seen = set()
        for t in probes:
            if t.get("pair") and t["pair"] in seen:
                continue
            seen.add(t.get("pair"))
            ok = t.get("pass")
            all_ok = all_ok and bool(ok)
            mark = "PASS" if ok else "FAIL"
            print(f"  [{mark}] {r['id']:<22} {r['arm']:>6}  turn {t['n']:<3} {t['probe']}")
            print(f"         {t['why']}")
            print(f"         -> {t.get('detail', '')}")
    print("\n" + "=" * 88)
    print("人格漂移 — 前半段 vs 后半段（字数 / 列表项 / 加粗）")
    print("=" * 88)
    for r in runs:
        d = drift(r["turns"])
        print(f"  {r['id']:<22} {r['arm']:>6}  "
              + "   ".join(f"{k} {v[0]}→{v[1]}" for k, v in d.items()))
    return all_ok


def write_html(runs: list[dict], path: str) -> None:
    blocks = []
    for r in runs:
        rows = "".join(
            f"<tr><td>{t['n']}</td><td class=q>{html.escape(t['say'])}</td>"
            f"<td><small>{t['chars']}字 · {t['list_items']}列</small>"
            f"<p>{html.escape(t['text'])}</p>"
            + (f"<div class='{'ok' if t.get('pass') else 'bad'}'>"
               f"{t['probe']}: {html.escape(str(t.get('detail', '')))}</div>"
               if t.get("probe") else "")
            + "</td></tr>"
            for t in r["turns"]
        )
        blocks.append(f"<h3>{html.escape(r['id'])} — arm: {r['arm']}</h3>"
                      f"<table>{rows}</table>")
    doc = f"""<meta charset="utf-8"><title>NURI coherence</title>
<style>
body{{font-family:system-ui,sans-serif;font-size:13px;margin:16px;max-width:1000px}}
table{{border-collapse:collapse;width:100%;margin-bottom:24px}}
td{{border:1px solid #ccc;padding:8px;vertical-align:top}}
td.q{{background:#f6f6f6;width:26%}}
p{{white-space:pre-wrap;margin:4px 0 0}}
.ok{{color:#0a6;font-weight:600;margin-top:6px}}
.bad{{color:#c00;font-weight:600;margin-top:6px}}
</style><h2>NURI 多轮一致性</h2>{''.join(blocks)}"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(doc)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--arms", default="window,memory")
    ap.add_argument("--window", type=int, default=6,
                    help="history window; small values push planted facts out of it cheaply")
    ap.add_argument("--only", default="", help="comma-separated conversation ids")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    arms = tuple(a.strip() for a in args.arms.split(",") if a.strip())
    for a in arms:
        if a not in ("window", "memory"):
            raise SystemExit(f"unknown arm {a!r}; use window and/or memory")

    convos = CONVERSATIONS
    if args.only:
        wanted = {c.strip() for c in args.only.split(",") if c.strip()}
        unknown = wanted - {c["id"] for c in CONVERSATIONS}
        if unknown:
            raise SystemExit(f"unknown conversation(s): {sorted(unknown)}")
        convos = tuple(c for c in CONVERSATIONS if c["id"] in wanted)

    calls = sum(len(c["turns"]) for c in convos) * len(arms)
    pairs = sum(1 for c in convos
                for t in c["turns"] if t.get("pair")) // 2 * len(arms)
    print(f"{calls} gpt-5.5 calls + {pairs} {JUDGE_MODEL} judge calls, window={args.window}")
    if not args.yes and input("run? [y/N] ").strip().lower() not in ("y", "yes"):
        raise SystemExit("aborted")

    llm_usage.new_request_id()
    llm_usage.set_user("eval:coherence")

    runs = [run_conversation(c, arm, args.window)
            for arm in arms for c in convos]
    ok = report(runs)

    os.makedirs(OUT_DIR, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = os.path.join(OUT_DIR, f"coherence_{stamp}")
    with open(base + ".json", "w", encoding="utf-8") as fh:
        json.dump({"stamp": stamp, "window": args.window,
                   "arms": list(arms), "runs": runs}, fh, ensure_ascii=False, indent=2)
    write_html(runs, base + ".html")
    print(f"\nwrote {base}.json\n      {base}.html")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
