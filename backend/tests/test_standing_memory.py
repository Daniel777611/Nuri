"""Standing memories: the constraints every reply and every home card must
respect, read whole instead of ranked against the question.

The case that motivated it: a parent told NURI weeks ago they had stopped sleep
training, and the home card still recommended sleep-training posts. No server,
no database and no model here — the database is a filtering fake and every
model call is replaced.
"""
import asyncio
import json
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import runtime  # noqa: E402
from backend.feed import daily_post as dp  # noqa: E402
from backend.feed import daily_video as dv  # noqa: E402
from backend.feed import standing  # noqa: E402
from backend.nuri_core import dialogue, family, family_store, safety  # noqa: E402
from backend.nuri_core.contracts import (  # noqa: E402
    Directive,
    EvidenceDecision,
    FamilyState,
    LearnedPolicy,
)
from backend.nuri_core.ports import CorePorts  # noqa: E402

NO_TRAINING = "已决定不做睡眠训练，不要再推荐训睡方法"


# ── fakes ────────────────────────────────────────────────────────────────────

class _Query:
    def __init__(self, db, table):
        self.db, self.table, self.filters, self.update_with = db, table, [], None

    def select(self, *_a):
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a):
        return self

    def update(self, values):
        self.update_with = values
        return self

    def _rows(self):
        return [
            r for r in self.db.setdefault(self.table, [])
            if all(r.get(c) == v for c, v in self.filters)
        ]

    def execute(self):
        rows = self._rows()
        if self.update_with is not None:
            for r in rows:
                r.update(self.update_with)
        return SimpleNamespace(data=[dict(r) for r in rows])


class _DB:
    def __init__(self, rows):
        self.tables = {"user_memories": rows}

    def table(self, name):
        return _Query(self.tables, name)


def _memory(category, key, value, status="active", user_id="u1", updated_at="2026-10-01"):
    return {"user_id": user_id, "category": category, "key": key, "value": value,
            "status": status, "updated_at": updated_at}


@pytest.fixture
def db(monkeypatch):
    fake = _DB([
        _memory("constraint", "睡眠训练", NO_TRAINING, updated_at="2026-10-02"),
        _memory("constraint", "过敏", "豆豆对花生过敏"),
        _memory("preference", "喂养", "母乳亲喂"),
        _memory("constraint", "旧的", "已经不成立的限制", status="archived"),
        _memory("constraint", "别人的", "别人家的限制", user_id="u2"),
    ])
    monkeypatch.setattr(runtime, "get_supabase", lambda: fake)
    return fake


class _Client:
    """Stands in for the sync OpenAI client; returns `content` as JSON."""

    def __init__(self, content=None, error=None):
        self.content, self.error, self.calls = content, error, []
        self.chat = self
        self.completions = self

    def with_options(self, **_k):
        return self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        message = SimpleNamespace(content=json.dumps(self.content, ensure_ascii=False))
        return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None)


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    monkeypatch.setattr(standing.llm_usage, "record", lambda *_a, **_k: None)
    family.clear_cache()
    dialogue.clear_cache()
    yield
    family.clear_cache()
    dialogue.clear_cache()


# ── the store ────────────────────────────────────────────────────────────────

def test_standing_memories_are_the_active_constraints_of_this_family_only(db):
    values = asyncio.run(family_store.load_standing_memories("u1"))
    assert values == [NO_TRAINING, "豆豆对花生过敏"]


def test_standing_memories_redact_child_names_for_the_feed(db):
    values = asyncio.run(family_store.load_standing_memories("u1", [{"nickname": "豆豆"}]))
    assert "孩子对花生过敏" in values and not any("豆豆" in v for v in values)


def test_ranked_memories_leave_out_what_the_standing_block_already_carries(db):
    ranked = asyncio.run(family_store.get_recalled_memory_context("u1", "怎么哄睡"))
    assert "母乳亲喂" in ranked and NO_TRAINING not in ranked
    # The linear pipeline has no standing block, so there they still compete.
    assert NO_TRAINING in asyncio.run(family_store.get_memory_context("u1", "睡眠训练"))


def test_retire_archives_only_the_named_active_row(db):
    asyncio.run(family_store.retire_memories(
        [{"category": "constraint", "key": "睡眠训练"}, {"category": "", "key": "x"}],
        user_id="u1",
    ))
    rows = {r["key"]: r["status"] for r in db.tables["user_memories"] if r["user_id"] == "u1"}
    assert rows["睡眠训练"] == "archived" and rows["过敏"] == "active"
    assert asyncio.run(family_store.load_standing_memories("u1")) == ["豆豆对花生过敏"]


def test_no_database_means_no_standing_memories(monkeypatch):
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)
    assert asyncio.run(family_store.load_standing_memories("u1")) == []
    assert asyncio.run(family_store.get_standing_context("u1")) == ""


# ── extraction ───────────────────────────────────────────────────────────────

def test_the_extractor_sees_what_is_remembered_and_can_retire_it(monkeypatch):
    client = _Client({"memories": [], "follow_ups": [],
                      "retire": [{"category": "child_state", "key": "睡眠训练"}]})
    monkeypatch.setattr(family_store, "oai", client)
    monkeypatch.setattr(family_store.llm_usage, "record", lambda *_a, **_k: None)

    out = family_store.extract_memories_sync(
        [{"role": "user", "text": "我们不训睡了，还是抱着哄吧"}],
        known=[{"category": "child_state", "key": "睡眠训练", "value": "正在用法伯法训睡"}],
    )

    request = client.calls[0]
    system, conversation = (m["content"] for m in request["messages"])
    assert "[child_state] 睡眠训练：正在用法伯法训睡" in conversation
    assert "我们不训睡了" in conversation
    assert "category=constraint" in system and "retire" in system
    schema = request["response_format"]["json_schema"]["schema"]
    assert schema["required"] == ["memories", "follow_ups", "retire"]
    assert out["retire"] == [{"category": "child_state", "key": "睡眠训练"}]


def test_retire_runs_before_the_upsert_so_a_rewritten_key_stays_active(monkeypatch):
    order = []

    async def known(_uid):
        return [{"category": "constraint", "key": "睡眠训练", "value": "在训睡"}]

    def extract(history, temporal_context=None, known=None):
        order.append(("extract", known))
        return {"memories": [{"category": "constraint", "key": "睡眠训练",
                              "value": NO_TRAINING, "confidence": 0.9}],
                "follow_ups": [], "retire": [{"category": "constraint", "key": "睡眠训练"}]}

    async def retire(items, **_k):
        order.append(("retire", items))

    async def upsert(memories, **_k):
        order.append(("upsert", memories))

    async def noop(*_a, **_k):
        return None

    monkeypatch.setattr(family_store, "worth_extracting", lambda _h: True)
    monkeypatch.setattr(family_store, "load_known_memories", known)
    monkeypatch.setattr(family_store, "extract_memories_sync", extract)
    monkeypatch.setattr(family_store, "retire_memories", retire)
    monkeypatch.setattr(family_store, "upsert_memories", upsert)
    monkeypatch.setattr(family_store, "upsert_follow_ups", noop)

    asyncio.run(family.extract_and_upsert_memories(
        [{"role": "user", "text": "我们决定不训睡了，太难受了"}], "u1", "m1",
    ))

    assert [step for step, _ in order] == ["extract", "retire", "upsert"]
    assert order[0][1][0]["key"] == "睡眠训练"


def test_restating_a_retired_memory_reactivates_it_with_the_new_value(monkeypatch):
    fake = _DB([{**_memory("constraint", "睡眠训练", "旧说法", status="archived"),
                 "id": "row1", "child_id": None, "confidence": 0.95}])

    # `is_` is only used by the upsert's child_id filter.
    _Query.is_ = lambda self, column, _null: self.eq(column, None)
    monkeypatch.setattr(runtime, "get_supabase", lambda: fake)
    try:
        asyncio.run(family_store.upsert_memories(
            [{"category": "constraint", "key": "睡眠训练", "value": NO_TRAINING, "confidence": 0.6}],
            user_id="u1", child_id=None, source_type="chat", source_id="m2",
        ))
    finally:
        del _Query.is_
    row = fake.tables["user_memories"][0]
    assert row["status"] == "active" and row["value"] == NO_TRAINING


# ── the reply prompt ─────────────────────────────────────────────────────────

async def _to_thread(fn, *args):
    return fn(*args)


def _async(value):
    async def _fn(*_a, **_k):
        return value
    return _fn


HINTS = {"nickname": "小雨妈妈", "children": [{"nickname": "豆豆", "birth_date": "2026-01-01"}]}


def _ports(**over):
    base = dict(
        to_thread=_to_thread,
        profile_ctx=lambda profile, children: f"称呼：{profile.get('nickname', '')}",
        age_label=lambda bd: "9个月",
        age_months=lambda bd: 9 if bd else None,
        memory_context=_async("家长偏好：母乳亲喂"),
        standing_context=_async(f"- {NO_TRAINING}"),
        follow_up_context=_async(""),
    )
    base.update(over)
    return CorePorts(**base)


def test_enrich_carries_the_standing_block_and_caches_it():
    calls = []

    async def standing_ctx(uid):
        calls.append(uid)
        return f"- {NO_TRAINING}"

    p = _ports(standing_context=standing_ctx)
    core = family.core(HINTS, p, uid="u1")
    first = asyncio.run(family.enrich(core, p))
    second = asyncio.run(family.enrich(core, p))
    assert first.standing_block == second.standing_block == f"- {NO_TRAINING}"
    assert second.cache_hit and calls == ["u1"]


def _plan(family_state, user_text="宝宝晚上老醒怎么办"):
    return dialogue.plan(
        family=family_state,
        evidence=EvidenceDecision(),
        policy=LearnedPolicy(),
        verdict=safety.assess(user_text, family=FamilyState(), is_urgent=lambda *_a: False),
        directives=[Directive(id="s1", text="少用列点")],
        state_block="这次聊了夜醒",
    )


def test_the_standing_block_is_in_every_prompt_inside_the_cached_prefix():
    p = _ports()
    enriched = asyncio.run(family.enrich(family.core(HINTS, p, uid="u1"), p))
    plan = _plan(enriched)
    headings = [h for h, _ in plan.sections]
    assert headings.index(dialogue.HEADINGS["standing"]) < headings.index(dialogue.HEADINGS["memory"])
    _global, per_family, per_turn = plan.system_parts("你叫 NURI。")
    assert NO_TRAINING in per_family and NO_TRAINING not in per_turn
    assert "这次聊了夜醒" in per_family  # the summary still sits inside the prefix


def test_without_standing_memories_the_prefix_seam_does_not_move():
    p = _ports(standing_context=_async(""))
    enriched = asyncio.run(family.enrich(family.core(HINTS, p, uid="u1"), p))
    _global, per_family, per_turn = _plan(enriched).system_parts("")
    assert "这次聊了夜醒" in per_family and "母乳亲喂" in per_turn


def test_the_seam_counts_only_sections_that_rendered():
    # No operator rules and no profile: the summary must still be the last
    # stable section rather than the per-turn memory slipping into the prefix.
    state = replace(FamilyState(), standing_block="", memory_block="家长偏好：母乳亲喂")
    plan = dialogue.plan(
        family=state, evidence=EvidenceDecision(), policy=LearnedPolicy(),
        verdict=safety.assess("hi", family=FamilyState(), is_urgent=lambda *_a: False),
        directives=[], state_block="这次聊了夜醒",
    )
    _global, per_family, per_turn = plan.system_parts("")
    assert "这次聊了夜醒" in per_family and "母乳亲喂" in per_turn


# ── the home cards ───────────────────────────────────────────────────────────

def test_prompt_block_is_empty_without_standing_memories():
    assert standing.prompt_block([]) == ""
    assert NO_TRAINING in standing.prompt_block([NO_TRAINING])


def test_the_check_rejects_a_conflicting_card(monkeypatch):
    client = _Client({"reason": "卡片在教训睡", "conflict": True})
    monkeypatch.setattr(runtime, "oai", client)
    assert standing.conflicts("如何用法伯法训睡", [NO_TRAINING], call_site="t") is True
    assert NO_TRAINING in client.calls[0]["messages"][1]["content"]


def test_the_check_fails_open_and_skips_when_there_is_nothing_to_check(monkeypatch):
    monkeypatch.setattr(runtime, "oai", _Client(error=TimeoutError()))
    assert standing.conflicts("如何训睡", [NO_TRAINING], call_site="t") is False
    never = _Client(error=AssertionError("must not be called"))
    monkeypatch.setattr(runtime, "oai", never)
    assert standing.conflicts("如何训睡", [], call_site="t") is False
    assert never.calls == []


def _post(text):
    return dp.Candidate(
        url="https://www.facebook.com/groups/momsgroup123/posts/" + str(abs(hash(text))),
        platform="facebook", title="t", text=text, ai_summary=False, lang="zh",
        label="Facebook 家长群",
    )


def _pick_for(choice, headline):
    return {"choice": choice, "author_kind": "parent", "fit": "strong", "post_topic": "夜醒",
            "question": "宝宝夜醒怎么办？", "situation": "", "headline": headline,
            "takeaways": ["一个做法"], "excerpt": "", "why_this": "", "caution": ""}


def test_a_post_that_conflicts_is_struck_and_the_next_one_chosen(monkeypatch):
    training, routine = _post("我们用哭声免疫法训睡，三天就好了"), _post("我们把睡前仪式固定下来，夜醒少了")
    asked = []

    def ask(remaining, **kwargs):
        asked.append((len(remaining), kwargs["standing"]))
        return _pick_for(0, "哭声免疫法训睡" if training in remaining else "固定睡前仪式")

    monkeypatch.setattr(dp, "_ask_pick", ask)
    monkeypatch.setattr(standing, "conflicts", lambda text, _s, **_k: "训睡" in text)

    picked = dp.pick_post([training, routine], concern="夜醒", child_age_context="",
                          locale="zh-CN", standing=[NO_TRAINING])

    assert picked["candidate"] is routine
    assert asked == [(2, [NO_TRAINING]), (1, [NO_TRAINING])]


def test_without_standing_memories_the_post_is_not_checked(monkeypatch):
    monkeypatch.setattr(dp, "_ask_pick", lambda remaining, **_k: _pick_for(0, "哭声免疫法训睡"))
    monkeypatch.setattr(standing, "conflicts", lambda *_a, **_k: pytest.fail("checked"))
    post = _post("我们用哭声免疫法训睡")
    assert dp.pick_post([post], concern="夜醒", child_age_context="", locale="zh-CN")["candidate"] is post


def test_the_pick_prompt_carries_the_standing_memories(monkeypatch):
    seen = {}

    def model_json(_site, messages, _fmt):
        seen["prompt"] = messages[1]["content"]
        return {"choice": -1}

    monkeypatch.setattr(dp, "_model_json", model_json)
    dp._ask_pick([_post("x")], concern="夜醒", child_age_context="", locale="zh-CN",
                 standing=[NO_TRAINING])
    assert NO_TRAINING in seen["prompt"]


def _videos(*titles):
    ids = ["vIULng1QDpo", "GXAyoxpqMag", "uJnQ5NLKn_c"]
    return dv.to_candidates(
        [SimpleNamespace(url=f"https://www.youtube.com/watch?v={ids[i]}", title=t,
                         snippet="A pediatrician explains.", lang="en")
         for i, t in enumerate(titles)],
        exclude_urls=set(),
    )


def _score(index, relevance):
    return {"index": index, "for_parents": True, "safe": True, "relevance": relevance,
            "expertise": 4, "speaker_kind": "pediatrician", "channel": "c", "display_title": ""}


def test_a_video_that_conflicts_falls_back_to_the_next_best(monkeypatch):
    cands = _videos("Sleep Training Your Baby: Ferber Method", "A Calm Bedtime Routine")
    seen = {}

    def scores(_c, **kwargs):
        seen["standing"] = kwargs["standing"]
        return [_score(0, 5), _score(1, 4)]

    monkeypatch.setattr(dv, "_ask_scores", scores)
    monkeypatch.setattr(standing, "conflicts", lambda text, _s, **_k: "Sleep Training" in text)

    pick = dv.pick_video(cands, concern="夜醒", child_age_context="", locale="zh-CN",
                         standing=[NO_TRAINING])
    assert pick["candidate"].title == "A Calm Bedtime Routine"
    assert seen["standing"] == [NO_TRAINING]


def test_when_every_video_conflicts_there_is_no_video(monkeypatch):
    cands = _videos("Sleep Training 101", "Sleep Training Ferber")
    monkeypatch.setattr(dv, "_ask_scores", lambda _c, **_k: [_score(0, 5), _score(1, 4)])
    monkeypatch.setattr(standing, "conflicts", lambda *_a, **_k: True)
    assert dv.pick_video(cands, concern="夜醒", child_age_context="", locale="zh-CN",
                         standing=[NO_TRAINING]) is None


def test_the_video_prompt_turns_a_conflict_into_unsafe(monkeypatch):
    seen = {}

    def model_json(_site, _model, messages, _fmt):
        seen["prompt"] = messages[1]["content"]
        return {"scores": []}

    monkeypatch.setattr(dv, "_model_json", model_json)
    dv._ask_scores(_videos("x"), concern="夜醒", child_age_context="", locale="zh-CN",
                   standing=[NO_TRAINING])
    assert NO_TRAINING in seen["prompt"] and "safe 填 false" in seen["prompt"]
