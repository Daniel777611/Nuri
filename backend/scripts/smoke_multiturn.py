"""Drive one multi-turn conversation against a deployed NURI and record it.

    python backend/scripts/smoke_multiturn.py --base https://<preview-host>
    python backend/scripts/smoke_multiturn.py --base ... --account 05 --out sample.json

This is the acceptance check behind BE-10 and A-02: five consecutive parent
turns on one conversation, driven the way an external runner drives it — real
HTTP, a real token, a stable client_message_id per turn.

The script exists rather than a manual curl session because the interesting
question is not whether five requests succeed. It is whether the reply to turn
five still knows what turn one said. So the transcript deliberately discloses
four facts early (age, feeding method, a work constraint, a food reaction) and
never repeats them, and the run reports which of those facts the model asked
about again after being told. A conversation that re-asks a known fact passes
every HTTP assertion and fails the product.

Nothing here grades the writing. It reports what was retained and what the
product emitted; judging the reply is the test party's job.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request

#: Each turn carries the facts it establishes and the facts it must not be
#: asked about again. "asked again" is judged by the probes, which are the
#: shapes a question about that fact actually takes in Chinese.
TURNS = [
    {
        "text": "寶寶八個月大，最近晚上一直醒，我快撐不住了",
        "establishes": "月齡=8個月",
        "probes": ["幾個月", "多大", "月齡", "几个月", "月龄"],
    },
    {
        "text": "一個晚上大概醒四次，每次都要親餵才睡得回去，這樣兩個禮拜了",
        "establishes": "夜醒四次／親餵入睡／持續兩週",
        "probes": ["醒幾次", "怎麼睡回去", "多久了", "醒几次", "持续多久"],
    },
    {
        "text": "我下個月要回去上班，先生上夜班，晚上只有我一個人顧",
        "establishes": "下月復職／夜間獨自照顧",
        "probes": ["有人幫忙嗎", "誰照顧", "工作", "有人帮忙", "谁照顾"],
    },
    {
        "text": "副食品吃到蛋黃的時候起了紅疹，後來就沒再給了",
        "establishes": "蛋黃疑似過敏",
        "probes": ["過敏", "副食品吃了什麼", "有沒有不舒服", "过敏", "辅食"],
    },
    {
        "text": "那我下禮拜可以先從哪一件事開始？",
        "establishes": "（要求收斂為可執行的第一步）",
        "probes": [],
    },
]


#: A question sentence, and only that: text since the last sentence boundary,
#: ending in a question mark. Splitting on the question mark alone keeps the
#: declarative sentences before it, so advice that merely uses a known fact
#: ("確認蛋過敏前後都要留意…") would score as a request for that fact and mark
#: good recall as a failure.
_QUESTION_RE = re.compile("[^。！？!?" + chr(10) + "]*[？?]")
def _questions(reply: str) -> list[str]:
    return [q.strip() for q in _QUESTION_RE.findall(reply or "") if q.strip()]


def _post(base: str, path: str, payload: dict, token: str = "") -> tuple[int, dict]:
    request = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return exc.code, {"detail": raw.decode("utf-8", "replace")[:400]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, help="deployment base URL")
    parser.add_argument("--account", default="05", help="two-digit test account number")
    parser.add_argument("--password", default="NuriTest2026!")
    parser.add_argument("--timezone", default="Asia/Taipei")
    parser.add_argument("--out", default="", help="write the transcript as JSON")
    parser.add_argument("--reset", action="store_true",
                        help="wipe the account's history first (POST /api/privacy/wipe)")
    args = parser.parse_args()

    email = f"automated_test_{args.account}@example.com"
    status, body = _post(args.base, "/api/auth/login",
                         {"email": email, "password": args.password})
    if status != 200 or not body.get("access_token"):
        print(f"[fail] login {status}: {str(body)[:200]}")
        return 1
    token = body["access_token"]
    print(f"account {email}  login ok")

    if args.reset:
        wipe_status, _ = _post(args.base, "/api/privacy/wipe", {}, token)
        print(f"reset: POST /api/privacy/wipe -> {wipe_status}")

    status, session = _post(args.base, "/api/chat/sessions", {}, token)
    if status != 200 or not session.get("id"):
        print(f"[fail] session {status}: {str(session)[:200]}")
        return 1
    session_id = session["id"]
    print(f"conversation {session_id}\n")

    run_id = int(time.time())
    transcript: list[dict] = []
    established: list[dict] = []
    for index, turn in enumerate(TURNS, start=1):
        started = time.perf_counter()
        status, body = _post(
            args.base, f"/api/chat/sessions/{session_id}/messages",
            {
                "text": turn["text"],
                "client_message_id": f"smoke-{run_id}-{index:02d}",
                "client_context": {"timezone": args.timezone},
            },
            token,
        )
        elapsed = int((time.perf_counter() - started) * 1000)
        if status != 200:
            print(f"[fail] turn {index} -> {status}: {str(body)[:300]}")
            return 1
        reply = ((body.get("ai_messages") or [{}])[0].get("text") or "")

        # Only facts established *before* this turn can be wrongly re-asked, and
        # only a question re-asks anything. Matching the whole reply counts
        # "確認蛋過敏前後都要留意…" — advice that uses the fact — as though it
        # were a request for it, which marks good recall as a failure.
        questions = _questions(reply)
        repeated = [
            fact["establishes"] for fact in established
            if any(probe in question for question in questions for probe in fact["probes"])
        ]
        print(f"── turn {index}  ({elapsed} ms)")
        print(f"   parent: {turn['text']}")
        print(f"   NURI  : {reply[:200]}{'…' if len(reply) > 200 else ''}")
        print(f"   events: {json.dumps(body.get('events'), ensure_ascii=False)}")
        if repeated:
            print(f"   [RE-ASKED] {'; '.join(repeated)}")
        print()

        transcript.append({
            "turn": index,
            "parent": turn["text"],
            "nuri": reply,
            "events": body.get("events"),
            "version": body.get("version"),
            "request_id": body.get("request_id"),
            "latency_ms": elapsed,
            "re_asked_known_facts": repeated,
        })
        if turn["probes"]:
            established.append(turn)

    reasked = sorted({f for row in transcript for f in row["re_asked_known_facts"]})
    print("=" * 60)
    print(f"turns: {len(transcript)}   "
          f"median latency: {sorted(r['latency_ms'] for r in transcript)[len(transcript)//2]} ms")
    if reasked:
        print(f"A-02 FAIL — NURI re-asked facts it had been told: {'; '.join(reasked)}")
    else:
        print("A-02 pass — no already-disclosed fact was asked about again")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump({
                "base": args.base,
                "conversation_id": session_id,
                "version": transcript[0]["version"] if transcript else None,
                "turns": transcript,
            }, handle, ensure_ascii=False, indent=2)
        print(f"wrote {args.out}")
    return 1 if reasked else 0


if __name__ == "__main__":
    raise SystemExit(main())
