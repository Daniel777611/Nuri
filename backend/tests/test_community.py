"""Community API (backend/community.py), through the real routes and envelope.

Storage is an in-memory Supabase stand-in (community_fakes.FakeDB) reached via
`runtime.get_supabase`, the one seam every store uses. Accounts are text ids
in public.users; tokens are the app's own JWTs.
"""

from __future__ import annotations

import base64
import hashlib
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import community, main, runtime
from backend.tests.community_fakes import FakeDB

V1 = community.PREFIX


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    for uid, role in (("u_ann", "mom"), ("u_ben", "dad"), ("u_cat", "mom"), ("u_dan", "dad"), ("u_eve", "other")):
        db.rows("users").append({"id": uid, "email": f"{uid}@example.test", "nickname": uid,
                                 "city": "Savannah", "parent_role": role})
    db.rows("children").append({"id": "c1", "user_id": "u_ann", "nickname": "Kid",
                                "birth_date": "2024-05-01"})
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(community, "DELIVERY_FANOUT", 10)
    client = TestClient(main.app)

    def call(uid, method, path, **kwargs):
        headers = {"Authorization": f"Bearer {main._make_token(uid)}"} if uid else {}
        return client.request(method, V1 + path, headers=headers, **kwargs)

    return SimpleNamespace(db=db, call=call, client=client)


def ok(resp, code=200):
    assert resp.status_code == code, resp.text
    return resp.json()


def err(resp, status_code, code):
    assert resp.status_code == status_code, resp.text
    body = resp.json()
    assert body["error"]["code"] == code, body
    return body


def make_profile(env, uid, name=None, **extra):
    return ok(env.call(uid, "PATCH", "/profiles/me",
                       json={"display_name": name or uid.split("_")[1].title(), **extra}))


def pid(env, uid):
    return ok(env.call(uid, "GET", "/profiles/me"))["profile"]["parent_id"]


def connect(env, a, b):
    inv = ok(env.call(a, "POST", "/invitations", json={"target_parent_id": pid(env, b),
                                                       "client_request_id": f"inv-{a}-{b}"}))
    ok(env.call(b, "POST", f"/invitations/{inv['invitation']['invitation_id']}/decisions",
                json={"decision": "accept", "client_request_id": f"dec-{a}-{b}"}))
    conv = ok(env.call(a, "POST", "/conversations", json={"target_parent_id": pid(env, b),
                                                          "client_request_id": f"conv-{a}-{b}"}))
    return conv["conversation"]["conversation_id"]


def ask(env, uid, body="宝宝托育告别时总哭，怎么办？", key="q-key-0001", **extra):
    return env.call(uid, "POST", "/questions", json={"body": body, "client_request_id": key, **extra})


# ── Auth & envelope ──────────────────────────────────────────────────────────

def test_every_route_requires_a_token(env):
    paths = {r.path for r in community.build_router(main._req_uid).routes}
    assert len(paths) >= 30
    resp = env.call(None, "GET", "/profiles/me")
    assert resp.status_code == 401


def test_unknown_fields_are_refused_with_validation_failed(env):
    body = err(env.call("u_ann", "PATCH", "/profiles/me", json={"display_name": "A", "email": "x"}),
               422, "VALIDATION_FAILED")
    assert body["detail"]


# ── P01–P03 Profiles ─────────────────────────────────────────────────────────

def test_profile_lifecycle_and_public_dto(env):
    first = ok(env.call("u_ann", "GET", "/profiles/me"))
    assert first["exists"] is False and first["profile"] is None
    err(env.call("u_ann", "PATCH", "/profiles/me", json={"about": "hi"}), 422, "VALIDATION_FAILED")
    made = make_profile(env, "u_ann", "Ann", about="I know a cafe", city="Savannah, GA",
                        intents=["casual_chat", "share_parenting_ideas"])
    assert made["profile"]["intents"] == ["share_parenting_ideas", "casual_chat"]
    assert made["profile"]["version"] == 1
    err(env.call("u_ann", "PATCH", "/profiles/me", json={"intents": ["dating"]}), 422, "VALIDATION_FAILED")
    stale = err(env.call("u_ann", "PATCH", "/profiles/me", json={"about": "x", "expected_version": 7}),
                409, "VERSION_CONFLICT")
    assert stale["context"]["current_version"] == 1

    make_profile(env, "u_ben")
    seen = ok(env.call("u_ben", "GET", f"/parents/{made['profile']['parent_id']}"))
    assert seen["parent"]["display_name"] == "Ann" and seen["parent"]["role"] == "mom"
    text = str(seen)
    assert "u_ann" not in text and "example.test" not in text and "2024-05-01" not in text
    assert seen["relationship"]["state"] == "none" and "invite" in seen["relationship"]["allowed_actions"]
    err(env.call("u_ben", "GET", f"/parents/{pid(env, 'u_ben')}"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    err(env.call("u_ben", "GET", "/parents/not-a-uuid"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")


def test_hidden_and_blocking_profiles_are_invisible_to_strangers(env):
    for u in ("u_ann", "u_ben", "u_cat"):
        make_profile(env, u)
    ok(env.call("u_ann", "PATCH", "/preferences", json={"profile_hidden": True}))
    err(env.call("u_ben", "GET", f"/parents/{pid(env, 'u_ann')}"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    ok(env.call("u_ann", "PATCH", "/preferences", json={"profile_hidden": False}))
    connect(env, "u_ann", "u_ben")
    ok(env.call("u_ann", "PATCH", "/preferences", json={"profile_hidden": True}))
    # A contact still sees a hidden profile; existing conversations are kept.
    ok(env.call("u_ben", "GET", f"/parents/{pid(env, 'u_ann')}"))
    ok(env.call("u_cat", "PUT", f"/me/blocks/{pid(env, 'u_ben')}", json={"confirmed": True}))
    # Ben cannot tell a block from a missing profile.
    err(env.call("u_ben", "GET", f"/parents/{pid(env, 'u_cat')}"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")


# ── P04 Discovery ────────────────────────────────────────────────────────────

def test_recommendations_filter_and_exclude(env):
    make_profile(env, "u_ann", intents=["outings_with_children"], share_location=True,
                 latitude=32.0809, longitude=-81.0912)
    make_profile(env, "u_ben", intents=["outings_with_children"], share_location=True,
                 latitude=32.0900, longitude=-81.1000)
    make_profile(env, "u_cat", share_location=True, latitude=33.7490, longitude=-84.3880)  # Atlanta
    make_profile(env, "u_dan")
    make_profile(env, "u_eve")
    ok(env.call("u_eve", "PATCH", "/preferences", json={"profile_hidden": True}))

    allp = ok(env.call("u_ann", "GET", "/recommendations"))
    names = {i["parent"]["display_name"] for i in allp["items"]}
    assert names == {"Ben", "Cat", "Dan"}  # not self, not hidden
    ben = next(i for i in allp["items"] if i["parent"]["display_name"] == "Ben")
    assert ben["shared_intents"] == ["outings_with_children"] and ben["distance_miles"] <= 1

    dads = ok(env.call("u_ann", "GET", "/recommendations", params={"role": "dad"}))
    assert {i["parent"]["display_name"] for i in dads["items"]} == {"Ben", "Dan"}
    near = ok(env.call("u_ann", "GET", "/recommendations", params={"distance_miles": 1}))
    assert [i["parent"]["display_name"] for i in near["items"]] == ["Ben"]
    err(env.call("u_dan", "GET", "/recommendations", params={"distance_miles": 3}), 422, "VALIDATION_FAILED")
    err(env.call("u_ann", "GET", "/recommendations", params={"distance_miles": 2}), 422, "VALIDATION_FAILED")

    paged = ok(env.call("u_ann", "GET", "/recommendations", params={"page_size": 1}))
    assert len(paged["items"]) == 1 and paged["has_more"] and paged["next_cursor"]
    nxt = ok(env.call("u_ann", "GET", "/recommendations", params={"page_size": 1, "cursor": paged["next_cursor"]}))
    assert nxt["items"][0]["parent"]["parent_id"] != paged["items"][0]["parent"]["parent_id"]

    ok(env.call("u_ann", "PUT", f"/me/blocks/{pid(env, 'u_dan')}", json={"confirmed": True}))
    connect(env, "u_ann", "u_ben")
    after = ok(env.call("u_ann", "GET", "/recommendations"))
    assert {i["parent"]["display_name"] for i in after["items"]} == {"Cat"}


# ── P05 / P29 / P30 AI calls ─────────────────────────────────────────────────

def test_polish_needs_consent_keeps_original_and_is_idempotent(env, monkeypatch):
    calls = []

    async def fake_complete(site, uid, system, text):
        calls.append(site)
        return "整理后的问题？"

    monkeypatch.setattr(community, "_complete", fake_complete)
    body = {"text": " 宝宝总哭 ", "ai_consent_version": "old", "client_request_id": "polish-0001"}
    err(env.call("u_ann", "POST", "/question-polishes", json=body), 403, "CONSENT_REQUIRED")
    body["ai_consent_version"] = community.NURI_AI_CONSENT_VERSION
    first = ok(env.call("u_ann", "POST", "/question-polishes", json=body))
    assert first["original"] == "宝宝总哭" and first["polish"]["text"] == "整理后的问题？"
    again = ok(env.call("u_ann", "POST", "/question-polishes", json=body))
    assert again["polish"]["id"] == first["polish"]["id"] and calls == ["community.polish"]
    err(env.call("u_ann", "POST", "/question-polishes", json={**body, "text": "别的"}), 409, "IDEMPOTENCY_CONFLICT")

    make_profile(env, "u_ann")
    q = ok(ask(env, "u_ann", body="整理后的问题？", version_source="polished",
               polish_id=first["polish"]["id"]), 201)
    assert q["question"]["version_source"] == "polished"
    err(ask(env, "u_ann", key="q-key-0002", version_source="polished"), 422, "VALIDATION_FAILED")


def test_translation_of_someone_elses_message_needs_both_parents(env, monkeypatch):
    async def fake_complete(site, uid, system, text):
        return f"EN:{text}"

    monkeypatch.setattr(community, "_complete", fake_complete)
    make_profile(env, "u_ann"); make_profile(env, "u_ben")
    conv = connect(env, "u_ann", "u_ben")
    early = ok(env.call("u_ben", "POST", f"/conversations/{conv}/messages",
                        json={"text": "早上好", "client_message_id": "msg-ben-0001"}), 201)["message"]
    tr = {"target_language": "en", "ai_consent_version": community.NURI_AI_CONSENT_VERSION,
          "client_request_id": "trans-0001"}
    err(env.call("u_ann", "POST", f"/messages/{early['message_id']}/translations", json=tr), 403, "CONSENT_REQUIRED")
    own = ok(env.call("u_ben", "POST", f"/messages/{early['message_id']}/translations", json=tr))
    assert own["translation"]["text"] == "EN:早上好" and own["original"]["text"] == "早上好"

    req = ok(env.call("u_ann", "POST", f"/conversations/{conv}/ai-consent-requests",
                      json={"purpose": "translation", "notice_version": community.AI_NOTICE_VERSION,
                            "client_request_id": "air-0001"}))["request"]
    ok(env.call("u_ben", "PUT", f"/ai-consent-requests/{req['request_id']}/my-decision",
                json={"decision": "allow", "notice_version": community.AI_NOTICE_VERSION,
                      "client_request_id": "aid-0001"}))
    # Consent covers what is said after it, not the history before it.
    err(env.call("u_ann", "POST", f"/messages/{early['message_id']}/translations",
                 json={**tr, "client_request_id": "trans-0002"}), 403, "CONSENT_REQUIRED")
    later = ok(env.call("u_ben", "POST", f"/conversations/{conv}/messages",
                        json={"text": "下午好", "client_message_id": "msg-ben-0002"}), 201)["message"]
    done = ok(env.call("u_ann", "POST", f"/messages/{later['message_id']}/translations",
                       json={**tr, "client_request_id": "trans-0003"}))
    assert done["translation"]["text"] == "EN:下午好"
    stored = [m for m in env.db.rows("community_messages") if m["id"] == later["message_id"]][0]
    assert stored["body"] == "下午好"  # never overwritten


def test_transcription_returns_a_draft_and_reuses_the_chat_path(env, monkeypatch):
    seen = []

    async def fake_transcribe(body, uid):
        seen.append((body.locale, uid))
        return {"text": "我想问一下睡眠"}

    monkeypatch.setattr(main, "transcribe_audio", fake_transcribe)
    body = {"audio_base64": "data:audio/m4a;base64,AAAA", "locale": "zh-CN",
            "ai_consent_version": community.NURI_AI_CONSENT_VERSION, "client_request_id": "asr-0001"}
    first = ok(env.call("u_ann", "POST", "/transcriptions", json=body))
    again = ok(env.call("u_ann", "POST", "/transcriptions", json=body))
    assert first["draft_text"] == again["draft_text"] == "我想问一下睡眠"
    assert seen == [("zh-CN", "u_ann")]
    assert not env.db.rows("community_messages")  # nothing was sent
    err(env.call("u_ann", "POST", "/transcriptions", json={**body, "ai_consent_version": "x",
                                                           "client_request_id": "asr-0002"}),
        403, "CONSENT_REQUIRED")


# ── P06–P10 Questions ────────────────────────────────────────────────────────

def test_question_publish_delivers_notifies_and_is_idempotent(env):
    err(ask(env, "u_ann"), 422, "VALIDATION_FAILED")  # no profile yet
    for u in ("u_ann", "u_ben", "u_cat"):
        make_profile(env, u)
    created = ok(ask(env, "u_ann", anonymous=True, show_child_age=True), 201)
    q = created["question"]
    assert created["delivery"]["recipient_count"] == 2 and created["created"] is True
    assert q["child_age_months"] and q["status"] == "open" and q["is_mine"]
    assert created["operation"]["state"] == "succeeded"
    op = ok(env.call("u_ann", "GET", f"/operations/{created['operation']['operation_id']}"))
    assert op["resource"]["id"] == q["question_id"]
    err(env.call("u_ben", "GET", f"/operations/{created['operation']['operation_id']}"), 404,
        "NOT_FOUND_OR_NOT_ACCESSIBLE")

    retry = ok(ask(env, "u_ann", anonymous=True, show_child_age=True), 200)
    assert retry["question"]["question_id"] == q["question_id"] and retry["created"] is False
    assert len(env.db.rows("community_questions")) == 1
    err(ask(env, "u_ann", body="别的问题", anonymous=True, show_child_age=True), 409, "IDEMPOTENCY_CONFLICT")

    events = [e for e in env.db.rows("notification_events") if e["data"]["kind"] == "community_question"]
    assert {e["user_id"] for e in events} == {"u_ben", "u_cat"} and len(events) == 2
    assert "托育" not in events[0]["title"] + events[0]["body"]  # lock screen stays vague
    assert events[0]["route"].startswith("/notifications/")

    seen = ok(env.call("u_ben", "GET", f"/questions/{q['question_id']}"))["question"]
    assert seen["author"]["anonymous"] is True and seen["author"]["parent_id"] is None
    assert seen["delivery"]["state"] == "waiting" and not seen["is_mine"]
    make_profile(env, "u_dan")
    err(env.call("u_dan", "GET", f"/questions/{q['question_id']}"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")


def test_question_rate_limit_and_validation(env, monkeypatch):
    make_profile(env, "u_ann")
    monkeypatch.setattr(community, "QUESTIONS_PER_DAY", 2)
    ok(ask(env, "u_ann", key="rate-0001"), 201)
    ok(ask(env, "u_ann", key="rate-0002"), 201)
    body = err(ask(env, "u_ann", key="rate-0003"), 429, "RATE_LIMITED")
    assert body["error"]["retryable"] is True
    err(ask(env, "u_cat", body="   ", key="blank-0001"), 422, "VALIDATION_FAILED")


def test_my_questions_search_and_paging(env):
    make_profile(env, "u_ann")
    for i, text in enumerate(["睡眠怎么办", "吃饭问题", "睡前仪式"]):
        ok(ask(env, "u_ann", body=text, key=f"mine-{i:04d}"), 201)
    page = ok(env.call("u_ann", "GET", "/me/questions", params={"page_size": 2}))
    assert [i["body"] for i in page["items"]] == ["睡前仪式", "吃饭问题"] and page["has_more"]
    rest = ok(env.call("u_ann", "GET", "/me/questions", params={"page_size": 2, "cursor": page["next_cursor"]}))
    assert [i["body"] for i in rest["items"]] == ["睡眠怎么办"] and not rest["has_more"]
    hits = ok(env.call("u_ann", "GET", "/me/questions", params={"q": "睡"}))
    assert len(hits["items"]) == 2
    err(env.call("u_ann", "GET", "/me/questions", params={"cursor": "garbage!"}), 422, "VALIDATION_FAILED")
    assert env.call("u_ann", "GET", "/me/questions", params={"page_size": 500}).status_code == 422


def test_close_and_delete_lock_deliveries_per_item(env):
    for u in ("u_ann", "u_ben"):
        make_profile(env, u)
    q1 = ok(ask(env, "u_ann", key="tr-q-0001"), 201)["question"]
    q2 = ok(ask(env, "u_ann", body="第二个", key="tr-q-0002"), 201)["question"]
    base = {"action": "close", "client_request_id": "batch-0001",
            "items": [{"question_id": q1["question_id"]}]}
    err(env.call("u_ann", "POST", "/questions/batch-transitions", json=base), 422, "VALIDATION_FAILED")
    res = ok(env.call("u_ann", "POST", "/questions/batch-transitions", json={
        **base, "confirmed": True,
        "items": [{"question_id": q1["question_id"]},
                  {"question_id": q2["question_id"], "expected_version": 9},
                  {"question_id": "00000000-0000-0000-0000-000000000000"}]}))
    assert [r["ok"] for r in res["results"]] == [True, False, False]
    assert res["results"][1]["error"]["code"] == "VERSION_CONFLICT"
    assert res["results"][2]["error"]["code"] == "NOT_FOUND_OR_NOT_ACCESSIBLE"
    locked = ok(env.call("u_ben", "GET", "/me/question-deliveries", params={"tab": "locked"}))
    assert [(i["question"]["question_id"], i["lock_reason"]) for i in locked["items"]] == [
        (q1["question_id"], "question_closed")]
    # Ben cannot close Ann's question.
    other = ok(env.call("u_ben", "POST", "/questions/batch-transitions", json={
        "action": "delete", "confirmed": True, "client_request_id": "batch-0002",
        "items": [{"question_id": q2["question_id"]}]}))
    assert other["results"][0]["ok"] is False
    ok(env.call("u_ann", "POST", "/questions/batch-transitions", json={
        "action": "delete", "confirmed": True, "client_request_id": "batch-0003",
        "items": [{"question_id": q2["question_id"]}]}))
    err(env.call("u_ben", "GET", f"/questions/{q2['question_id']}"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    mine = ok(env.call("u_ann", "GET", "/me/questions"))
    assert [i["status"] for i in mine["items"]] == ["closed"]


# ── P11–P14 Deliveries, responses, replies, comments ─────────────────────────

def _delivery(env, uid, tab="waiting"):
    return ok(env.call(uid, "GET", "/me/question-deliveries", params={"tab": tab}))["items"]


def test_responding_once_per_delivery(env):
    for u in ("u_ann", "u_ben", "u_cat"):
        make_profile(env, u)
    q = ok(ask(env, "u_ann"), 201)["question"]
    d = _delivery(env, "u_ben")[0]
    body = {"body": "我们用了告别仪式", "client_request_id": "resp-ben-0001"}
    first = ok(env.call("u_ben", "POST", f"/question-deliveries/{d['delivery_id']}/responses", json=body), 201)
    assert first["delivery"]["state"] == "replied"
    again = ok(env.call("u_ben", "POST", f"/question-deliveries/{d['delivery_id']}/responses", json=body), 200)
    assert again["reply"]["reply_id"] == first["reply"]["reply_id"]
    err(env.call("u_ben", "POST", f"/question-deliveries/{d['delivery_id']}/responses",
                 json={**body, "client_request_id": "resp-ben-0002"}), 409, "DELIVERY_LOCKED")
    err(env.call("u_cat", "POST", f"/question-deliveries/{d['delivery_id']}/responses",
                 json={**body, "client_request_id": "resp-cat-0001"}), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    replied = _delivery(env, "u_ben", "replied")
    assert replied[0]["my_reply"]["body"] == "我们用了告别仪式"
    assert [e["user_id"] for e in env.db.rows("notification_events")
            if e["data"]["kind"] == "community_reply"] == ["u_ann"]

    ok(env.call("u_ann", "POST", "/questions/batch-transitions", json={
        "action": "close", "confirmed": True, "client_request_id": "close-0001",
        "items": [{"question_id": q["question_id"]}]}))
    cat_d = _delivery(env, "u_cat", "locked")[0]
    err(env.call("u_cat", "POST", f"/question-deliveries/{cat_d['delivery_id']}/responses",
                 json={**body, "client_request_id": "resp-cat-0002"}), 409, "QUESTION_CLOSED")


def test_expired_deliveries_move_to_locked(env):
    for u in ("u_ann", "u_ben"):
        make_profile(env, u)
    ok(ask(env, "u_ann"), 201)
    for row in env.db.rows("community_question_deliveries"):
        row["expires_at"] = "2020-01-01T00:00:00+00:00"
    assert _delivery(env, "u_ben") == []
    locked = _delivery(env, "u_ben", "locked")
    assert locked[0]["lock_reason"] == "expired"
    err(env.call("u_ben", "POST", f"/question-deliveries/{locked[0]['delivery_id']}/responses",
                 json={"body": "late", "client_request_id": "late-0001"}), 409, "DELIVERY_LOCKED")


def test_reply_visibility_and_comment_threads(env):
    for u in ("u_ann", "u_ben", "u_cat", "u_dan"):
        make_profile(env, u)
    q = ok(ask(env, "u_ann"), 201)["question"]
    qid = q["question_id"]
    replies = {}
    for u in ("u_ben", "u_cat"):
        d = next(x for x in _delivery(env, u) if x["question"]["question_id"] == qid)
        replies[u] = ok(env.call(u, "POST", f"/question-deliveries/{d['delivery_id']}/responses",
                                 json={"body": f"{u} 的经验", "anonymous": u == "u_cat",
                                       "client_request_id": f"rr-{u}-0001"}), 201)["reply"]

    asker = ok(env.call("u_ann", "GET", f"/questions/{qid}/replies"))
    assert len(asker["items"]) == 2 and asker["all_thread"]["can_post"] is True
    cat_reply = next(i for i in asker["items"] if i["reply_id"] == replies["u_cat"]["reply_id"])
    assert cat_reply["author"]["anonymous"] is True and cat_reply["author"]["parent_id"] is None
    ben_view = ok(env.call("u_ben", "GET", f"/questions/{qid}/replies"))
    assert [i["reply_id"] for i in ben_view["items"]] == [replies["u_ben"]["reply_id"]]
    assert ben_view["all_thread"]["can_post"] is False

    path_all = f"/questions/{qid}/reply-threads/all/comments"
    ok(env.call("u_ann", "POST", path_all, json={"body": "谢谢大家", "client_message_id": "cm-all-0001"}), 201)
    err(env.call("u_ben", "POST", path_all, json={"body": "不客气", "client_message_id": "cm-all-0002"}),
        403, "RELATIONSHIP_NOT_ALLOWED")
    assert [c["body"] for c in ok(env.call("u_cat", "GET", path_all))["items"]] == ["谢谢大家"]

    ben_thread = f"/questions/{qid}/reply-threads/{replies['u_ben']['reply_id']}/comments"
    ok(env.call("u_ann", "POST", ben_thread, json={"body": "具体怎么做？", "client_message_id": "cm-b-0001"}), 201)
    ok(env.call("u_ben", "POST", ben_thread, json={"body": "每天同一句话", "client_message_id": "cm-b-0002"}), 201)
    thread = ok(env.call("u_ben", "GET", ben_thread))
    assert [c["body"] for c in thread["items"]] == ["每天同一句话", "具体怎么做？"]
    # Same text, other question / other thread: isolated.
    err(env.call("u_cat", "GET", ben_thread), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    err(env.call("u_dan", "GET", path_all), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    retry = ok(env.call("u_ben", "POST", ben_thread, json={"body": "每天同一句话", "client_message_id": "cm-b-0002"}))
    assert retry["created"] is False

    ok(env.call("u_ann", "POST", "/questions/batch-transitions", json={
        "action": "close", "confirmed": True, "client_request_id": "close-0002", "items": [{"question_id": qid}]}))
    err(env.call("u_ann", "POST", ben_thread, json={"body": "再问", "client_message_id": "cm-b-0003"}),
        409, "QUESTION_CLOSED")


# ── P15–P19 Relationships ────────────────────────────────────────────────────

def test_invitations_pending_accept_decline_and_crossing(env):
    for u in ("u_ann", "u_ben", "u_cat"):
        make_profile(env, u)
    sent = ok(env.call("u_ann", "POST", "/invitations", json={"target_parent_id": pid(env, "u_ben"),
                                                             "client_request_id": "inv-0001"}))
    assert sent["invitation"]["state"] == "pending" and sent["relationship"]["state"] == "invitation_sent"
    assert not env.db.rows("community_relationships")  # pending is not contacts
    dup = ok(env.call("u_ann", "POST", "/invitations", json={"target_parent_id": pid(env, "u_ben"),
                                                            "client_request_id": "inv-0002"}))
    assert dup["invitation"]["invitation_id"] == sent["invitation"]["invitation_id"]
    received = ok(env.call("u_ben", "GET", "/invitations"))
    assert [i["parent"]["display_name"] for i in received["items"]] == ["Ann"]
    assert ok(env.call("u_ann", "GET", "/invitations", params={"direction": "sent"}))["items"]

    iid = sent["invitation"]["invitation_id"]
    err(env.call("u_ann", "POST", f"/invitations/{iid}/decisions",
                 json={"decision": "accept", "client_request_id": "dec-0001"}), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    acc = ok(env.call("u_ben", "POST", f"/invitations/{iid}/decisions",
                      json={"decision": "accept", "client_request_id": "dec-0002"}))
    assert acc["invitation"]["state"] == "accepted" and acc["relationship"]["state"] == "connected"
    ok(env.call("u_ben", "POST", f"/invitations/{iid}/decisions",
                json={"decision": "accept", "client_request_id": "dec-0003"}))  # idempotent
    err(env.call("u_ben", "POST", f"/invitations/{iid}/decisions",
                 json={"decision": "decline", "client_request_id": "dec-0004"}), 409, "VERSION_CONFLICT")
    assert len(env.db.rows("community_relationships")) == 1

    # Crossing invitations merge into one relationship.
    ok(env.call("u_cat", "POST", "/invitations", json={"target_parent_id": pid(env, "u_ann"),
                                                      "client_request_id": "inv-0003"}))
    merged = ok(env.call("u_ann", "POST", "/invitations", json={"target_parent_id": pid(env, "u_cat"),
                                                               "client_request_id": "inv-0004"}))
    assert merged["relationship"]["state"] == "connected" and merged["invitation"]["state"] == "accepted"
    contacts = ok(env.call("u_ann", "GET", "/me/contacts"))
    assert {c["parent"]["display_name"] for c in contacts["items"]} == {"Ben", "Cat"}
    assert [c["parent"]["display_name"] for c in
            ok(env.call("u_ann", "GET", "/me/contacts", params={"q": "ca"}))["items"]] == ["Cat"]

    make_profile(env, "u_dan")
    d = ok(env.call("u_dan", "POST", "/invitations", json={"target_parent_id": pid(env, "u_ann"),
                                                          "client_request_id": "inv-0005"}))
    dec = ok(env.call("u_ann", "POST", f"/invitations/{d['invitation']['invitation_id']}/decisions",
                      json={"decision": "decline", "client_request_id": "dec-0005"}))
    assert dec["invitation"]["state"] == "declined" and dec["relationship"]["state"] == "none"


def test_disconnect_and_block_cut_every_channel(env):
    for u in ("u_ann", "u_ben", "u_cat"):
        make_profile(env, u)
    conv = connect(env, "u_ann", "u_ben")
    rel = ok(env.call("u_ann", "GET", "/me/contacts"))["items"][0]
    err(env.call("u_ann", "DELETE", f"/relationships/{rel['relationship_id']}"), 422, "VALIDATION_FAILED")
    gone = ok(env.call("u_ann", "DELETE", f"/relationships/{rel['relationship_id']}", params={"confirmed": True}))
    assert gone["state"] == "disconnected"
    err(env.call("u_ben", "POST", f"/conversations/{conv}/messages",
                 json={"text": "hi", "client_message_id": "after-0001"}), 403, "BLOCKED_OR_DISCONNECTED")
    # History stays readable.
    ok(env.call("u_ben", "GET", f"/conversations/{conv}/messages"))
    err(env.call("u_cat", "DELETE", f"/relationships/{rel['relationship_id']}", params={"confirmed": True}),
        404, "NOT_FOUND_OR_NOT_ACCESSIBLE")

    # Block: pending invitations, waiting deliveries and AI all end.
    ok(env.call("u_cat", "POST", "/invitations", json={"target_parent_id": pid(env, "u_ann"),
                                                      "client_request_id": "inv-blk-0001"}))
    ok(ask(env, "u_cat", key="blk-q-0001"), 201)
    err(env.call("u_ann", "PUT", f"/me/blocks/{pid(env, 'u_cat')}", json={}), 422, "VALIDATION_FAILED")
    blocked = ok(env.call("u_ann", "PUT", f"/me/blocks/{pid(env, 'u_cat')}", json={"confirmed": True}))
    assert blocked["relationship"]["state"] == "blocked_by_me"
    assert all(i["state"] == "cancelled" for i in env.db.rows("community_invitations")
               if i["sender_id"] == "u_cat")
    locked = _delivery(env, "u_ann", "locked")
    assert locked and locked[0]["lock_reason"] == "unavailable"
    assert [b["parent"]["display_name"] for b in ok(env.call("u_ann", "GET", "/me/blocks"))["items"]] == ["Cat"]
    err(env.call("u_ann", "POST", "/invitations", json={"target_parent_id": pid(env, "u_cat"),
                                                       "client_request_id": "inv-blk-0002"}),
        403, "BLOCKED_OR_DISCONNECTED")
    # Cat cannot even see Ann any more, so cannot invite again.
    err(env.call("u_cat", "POST", "/invitations", json={"target_parent_id": pid(env, "u_ann"),
                                                       "client_request_id": "inv-blk-0003"}),
        404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    un = ok(env.call("u_ann", "DELETE", f"/me/blocks/{pid(env, 'u_cat')}", params={"confirmed": True}))
    assert un["blocked"] is False and un["relationship"]["state"] == "none"  # nothing restored
    assert ok(env.call("u_ann", "GET", "/me/blocks"))["items"] == []


# ── P20–P23 Conversations ────────────────────────────────────────────────────

def test_p2p_messages_paging_idempotency_unread_and_inbox(env):
    for u in ("u_ann", "u_ben", "u_cat"):
        make_profile(env, u)
    err(env.call("u_ann", "POST", "/conversations", json={"target_parent_id": pid(env, "u_ben"),
                                                         "client_request_id": "conv-0001"}),
        403, "RELATIONSHIP_NOT_ALLOWED")
    conv = connect(env, "u_ann", "u_ben")
    started = ok(env.call("u_ann", "POST", "/conversations", json={"target_parent_id": pid(env, "u_ben"),
                                                                  "client_request_id": "conv-0002"}))
    assert started["conversation"]["conversation_id"] == conv and started["conversation"]["ai"]["effective"] is False
    for i in range(3):
        ok(env.call("u_ann", "POST", f"/conversations/{conv}/messages",
                    json={"text": f"m{i}", "client_message_id": f"ann-msg-{i:04d}"}), 201)
    retry = ok(env.call("u_ann", "POST", f"/conversations/{conv}/messages",
                        json={"text": "m2", "client_message_id": "ann-msg-0002"}), 200)
    assert retry["created"] is False and len(env.db.rows("community_messages")) == 3
    err(env.call("u_ann", "POST", f"/conversations/{conv}/messages",
                 json={"text": "changed", "client_message_id": "ann-msg-0002"}), 409, "IDEMPOTENCY_CONFLICT")
    err(env.call("u_ann", "POST", f"/conversations/{conv}/messages",
                 json={"text": "  ", "client_message_id": "ann-msg-0009"}), 422, "VALIDATION_FAILED")
    # The NURI chat tables are never touched by P2P messaging.
    assert not env.db.rows("chat_messages") and not env.db.rows("chat_sessions")

    page = ok(env.call("u_ben", "GET", f"/conversations/{conv}/messages", params={"page_size": 2}))
    assert [m["text"] for m in page["items"]] == ["m1", "m2"] and page["has_more"]
    older = ok(env.call("u_ben", "GET", f"/conversations/{conv}/messages",
                        params={"page_size": 2, "cursor": page["next_cursor"]}))
    assert [m["text"] for m in older["items"]] == ["m0"] and older["items"][0]["sender"] == "parent"
    err(env.call("u_cat", "GET", f"/conversations/{conv}/messages"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")

    box = ok(env.call("u_ben", "GET", "/me/inbox"))
    assert box["items"][0]["unread_count"] == 3 and box["items"][0]["last_message"]["preview"] == "m2"
    assert box["summary"]["unread_conversations"] == 1
    assert ok(env.call("u_ann", "GET", "/me/inbox"))["items"][0]["unread_count"] == 0

    mid = page["items"][0]["seq"]
    cur = ok(env.call("u_ben", "PUT", f"/conversations/{conv}/read-cursor", json={"last_read_seq": mid}))
    assert cur["unread_count"] == 1
    back = ok(env.call("u_ben", "PUT", f"/conversations/{conv}/read-cursor", json={"last_read_seq": 0}))
    assert back["last_read_seq"] == mid  # never moves backwards
    err(env.call("u_ben", "PUT", f"/conversations/{conv}/read-cursor", json={"last_read_seq": 99999}),
        422, "VALIDATION_FAILED")
    kinds = [e["data"]["kind"] for e in env.db.rows("notification_events") if e["user_id"] == "u_ben"]
    assert kinds.count("community_conversation") == 3


# ── P24 Preferences ──────────────────────────────────────────────────────────

def test_preferences_semantics_versions_and_notification_opt_out(env):
    prefs = ok(env.call("u_ben", "GET", "/preferences"))
    assert prefs == {"parent_message_notifications_enabled": True, "profile_hidden": False,
                     "auto_translate_messages": False, "version": 0}
    saved = ok(env.call("u_ben", "PATCH", "/preferences",
                        json={"parent_message_notifications_enabled": False, "expected_version": 0}))
    assert saved["version"] == 1 and saved["parent_message_notifications_enabled"] is False
    err(env.call("u_ben", "PATCH", "/preferences", json={"profile_hidden": True, "expected_version": 0}),
        409, "VERSION_CONFLICT")
    err(env.call("u_ben", "PATCH", "/preferences", json={"discoverable": True}), 422, "VALIDATION_FAILED")
    for u in ("u_ann", "u_ben"):
        make_profile(env, u)
    ok(ask(env, "u_ann"), 201)
    assert not [e for e in env.db.rows("notification_events") if e["user_id"] == "u_ben"]
    assert _delivery(env, "u_ben")  # delivered, just not pushed


# ── P25–P28 Two-party AI consent ─────────────────────────────────────────────

def test_ai_needs_both_parents_and_any_revoke_wins(env):
    for u in ("u_ann", "u_ben", "u_cat"):
        make_profile(env, u)
    conv = connect(env, "u_ann", "u_ben")
    n = community.AI_NOTICE_VERSION
    err(env.call("u_ann", "POST", f"/conversations/{conv}/ai-consent-requests",
                 json={"notice_version": "old", "client_request_id": "air-old-0001"}),
        409, "CONSENT_REVOKED_OR_CHANGED")
    req = ok(env.call("u_ann", "POST", f"/conversations/{conv}/ai-consent-requests",
                      json={"notice_version": n, "client_request_id": "air-0001"}))["request"]
    assert req["state"] == "pending" and req["my_decision"] == "allow" and req["parent_decision"] == "pending"
    assert ok(env.call("u_ann", "GET", f"/conversations/{conv}/ai-participation"))["effective"] is False
    same = ok(env.call("u_ben", "POST", f"/conversations/{conv}/ai-consent-requests",
                       json={"notice_version": n, "client_request_id": "air-0002"}))
    assert same["request"]["request_id"] == req["request_id"] and same["created"] is False
    err(env.call("u_cat", "PUT", f"/ai-consent-requests/{req['request_id']}/my-decision",
                 json={"decision": "allow", "notice_version": n, "client_request_id": "aid-cat-0001"}),
        404, "NOT_FOUND_OR_NOT_ACCESSIBLE")

    done = ok(env.call("u_ben", "PUT", f"/ai-consent-requests/{req['request_id']}/my-decision",
                       json={"decision": "allow", "notice_version": n, "client_request_id": "aid-0001"}))
    assert done["request"]["state"] == "effective"
    act = ok(env.call("u_ben", "GET", f"/conversations/{conv}/ai-participation"))
    assert act["effective"] is True and act["operations"] == []

    off = ok(env.call("u_ben", "DELETE", f"/conversations/{conv}/ai-participation"))
    assert off["effective"] is False and off["epoch"] == act["epoch"] + 1
    # The old sheet cannot bring it back.
    err(env.call("u_ann", "PUT", f"/ai-consent-requests/{req['request_id']}/my-decision",
                 json={"decision": "allow", "notice_version": n, "client_request_id": "aid-0002"}),
        409, "CONSENT_REVOKED_OR_CHANGED")

    req2 = ok(env.call("u_ben", "POST", f"/conversations/{conv}/ai-consent-requests",
                       json={"notice_version": n, "client_request_id": "air-0003"}))["request"]
    no = ok(env.call("u_ann", "PUT", f"/ai-consent-requests/{req2['request_id']}/my-decision",
                     json={"decision": "decline", "notice_version": n, "client_request_id": "aid-0003"}))
    assert no["request"]["state"] == "declined"
    assert ok(env.call("u_ann", "GET", f"/conversations/{conv}/ai-participation"))["effective"] is False

    req3 = ok(env.call("u_ben", "POST", f"/conversations/{conv}/ai-consent-requests",
                       json={"notice_version": n, "client_request_id": "air-0004"}))["request"]
    ok(env.call("u_ann", "PUT", f"/ai-consent-requests/{req3['request_id']}/my-decision",
                json={"decision": "allow", "notice_version": n, "client_request_id": "aid-0004"}))
    ok(env.call("u_ann", "PUT", f"/me/blocks/{pid(env, 'u_ben')}", json={"confirmed": True}))
    assert ok(env.call("u_ben", "GET", f"/conversations/{conv}/ai-participation"))["effective"] is False


# ── P31–P34 Media ────────────────────────────────────────────────────────────

def _png(color=(200, 10, 10)):
    buf = BytesIO()
    Image.new("RGB", (8, 6), color).save(buf, format="PNG")
    return buf.getvalue()


def _upload(env, uid, raw, key, purpose="message", sha=None):
    made = ok(env.call(uid, "POST", "/media/uploads", json={
        "purpose": purpose, "mime_type": "image/png", "byte_size": len(raw),
        "sha256": sha or hashlib.sha256(raw).hexdigest(), "client_request_id": key}))
    path = made["upload"]["url"].split("/upload/", 1)[1]
    env.db.storage.objects[path] = raw
    return made["media"]["media_id"]


def test_media_upload_validate_send_access_delete(env):
    for u in ("u_ann", "u_ben", "u_cat"):
        make_profile(env, u)
    conv = connect(env, "u_ann", "u_ben")
    err(env.call("u_ann", "POST", "/media/uploads", json={
        "purpose": "message", "mime_type": "video/mp4", "byte_size": 10, "sha256": "a" * 64,
        "client_request_id": "media-bad-0001"}), 422, "VALIDATION_FAILED")

    raw = _png()
    media_id = _upload(env, "u_ann", raw, "media-0001")
    err(env.call("u_ann", "POST", f"/conversations/{conv}/messages",
                 json={"media_ids": [media_id], "client_message_id": "media-msg-0001"}),
        422, "MEDIA_NOT_READY_OR_NOT_OWNED")
    ready = ok(env.call("u_ann", "POST", f"/media/uploads/{media_id}/complete", json={}))["media"]
    assert ready["state"] == "ready" and ready["width"] == 8 and ready["height"] == 6
    err(env.call("u_ben", "POST", f"/conversations/{conv}/messages",
                 json={"media_ids": [media_id], "client_message_id": "media-msg-0002"}),
        422, "MEDIA_NOT_READY_OR_NOT_OWNED")  # not Ben's
    sent = ok(env.call("u_ann", "POST", f"/conversations/{conv}/messages",
                       json={"media_ids": [media_id], "client_message_id": "media-msg-0003"}), 201)
    assert sent["message"]["media"] == [{"media_id": media_id}]
    access = ok(env.call("u_ben", "GET", f"/media/{media_id}/access"))
    assert access["access"]["url"].startswith("https://storage.test/read/")
    err(env.call("u_cat", "GET", f"/media/{media_id}/access"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    err(env.call("u_ann", "DELETE", f"/media/{media_id}"), 422, "MEDIA_NOT_READY_OR_NOT_OWNED")

    # Bytes that do not match what was declared are rejected and removed.
    fake = b"\x89PNG\r\n\x1a\n" + b"0" * 40
    bad = _upload(env, "u_ann", fake, "media-0002")
    assert ok(env.call("u_ann", "POST", f"/media/uploads/{bad}/complete", json={}))["media"]["reject_reason"] == "invalid_image"
    wrong = _upload(env, "u_ann", raw, "media-0003", sha="b" * 64)
    assert ok(env.call("u_ann", "POST", f"/media/uploads/{wrong}/complete", json={}))["media"]["state"] == "rejected"

    draft = _upload(env, "u_ann", _png((0, 0, 255)), "media-0004")
    assert ok(env.call("u_ann", "DELETE", f"/media/{draft}"))["state"] == "deleted"
    err(env.call("u_ben", "DELETE", f"/media/{media_id}"), 422, "MEDIA_NOT_READY_OR_NOT_OWNED")


def test_avatar_media_is_bound_to_the_profile(env):
    make_profile(env, "u_ann"); make_profile(env, "u_ben")
    avatar = _upload(env, "u_ann", _png(), "avatar-0001", purpose="avatar")
    err(env.call("u_ann", "PATCH", "/profiles/me", json={"avatar_media_id": avatar}),
        422, "MEDIA_NOT_READY_OR_NOT_OWNED")
    ok(env.call("u_ann", "POST", f"/media/uploads/{avatar}/complete", json={}))
    prof = ok(env.call("u_ann", "PATCH", "/profiles/me", json={"avatar_media_id": avatar}))
    assert prof["profile"]["avatar"] == {"media_id": avatar}
    ok(env.call("u_ben", "GET", f"/media/{avatar}/access"))
    ok(env.call("u_ann", "PUT", f"/me/blocks/{pid(env, 'u_ben')}", json={"confirmed": True}))
    err(env.call("u_ben", "GET", f"/media/{avatar}/access"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")


# ── P35–P36 Notifications, and the guard on the NURI open route ─────────────

def test_community_notifications_list_target_read_and_open_guard(env):
    for u in ("u_ann", "u_ben"):
        make_profile(env, u)
    conv = connect(env, "u_ann", "u_ben")
    ok(env.call("u_ann", "POST", f"/conversations/{conv}/messages",
                json={"text": "hi", "client_message_id": "nt-msg-0001"}), 201)
    env.db.rows("notification_events").append({
        "id": "11111111-1111-1111-1111-111111111111", "user_id": "u_ben", "type": "follow_up",
        "title": "care", "body": "care", "data": {"kind": "care"}, "status": "sent",
        "created_at": "2026-11-01T00:00:00+00:00", "dedupe_key": "care-x"})
    items = ok(env.call("u_ben", "GET", "/me/notifications"))["items"]
    assert [i["kind"] for i in items] == ["community_conversation", "community_invitation"]
    nid = items[0]["notification_id"]
    tgt = ok(env.call("u_ben", "GET", f"/me/notifications/{nid}/target"))
    assert tgt["accessible"] is True and tgt["target"]["conversation_id"] == conv
    err(env.call("u_ann", "GET", f"/me/notifications/{nid}/target"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
    read = ok(env.call("u_ben", "POST", f"/me/notifications/{nid}/read"))
    assert read["read_at"]
    assert ok(env.call("u_ben", "POST", f"/me/notifications/{nid}/read"))["read_at"] == read["read_at"]
    page = ok(env.call("u_ben", "GET", "/me/notifications", params={"page_size": 1}))
    nxt = ok(env.call("u_ben", "GET", "/me/notifications", params={"page_size": 1, "cursor": page["next_cursor"]}))
    assert nxt["items"][0]["notification_id"] != page["items"][0]["notification_id"]

    headers = {"Authorization": f"Bearer {main._make_token('u_ben')}"}
    opened = env.client.post(f"/api/notifications/{nid}/open", headers=headers)
    assert opened.status_code == 403 and opened.json()["error"]["code"] == "RELATIONSHIP_NOT_ALLOWED"
    assert not env.db.rows("chat_messages")  # no NURI message was written
    detail = env.client.get(f"/api/notifications/{nid}", headers=headers).json()
    assert detail["target"]["kind"] == "community_conversation"

    ok(env.call("u_ben", "PUT", f"/me/blocks/{pid(env, 'u_ann')}", json={"confirmed": True}))
    gone = ok(env.call("u_ben", "GET", f"/me/notifications/{nid}/target"))
    assert gone["accessible"] is False and gone["target"] is None


def test_storage_outage_is_an_error_not_an_empty_list(env):
    make_profile(env, "u_ann")
    env.db.fail_tables.add("community_questions")
    body = err(env.call("u_ann", "GET", "/me/questions"), 503, "STORAGE_OR_SERVICE_UNAVAILABLE")
    assert body["error"]["retryable"] is True


def test_direct_media_upload_validates_stores_and_is_idempotent(env):
    for u in ("u_ann", "u_ben", "u_cat"):
        make_profile(env, u)
    conv = connect(env, "u_ann", "u_ben")
    raw = _png()
    uri = "data:image/png;base64," + base64.b64encode(raw).decode()
    body = {"purpose": "message", "data_uri": uri, "client_request_id": "direct-0001"}
    first = ok(env.call("u_ann", "POST", "/media", json=body), 201)["media"]
    assert first["state"] == "ready" and first["width"] == 8 and first["mime_type"] == "image/png"
    again = ok(env.call("u_ann", "POST", "/media", json=body), 200)["media"]
    assert again["media_id"] == first["media_id"]
    assert len(env.db.storage.objects) == 1  # the retry stored nothing new
    other = "data:image/png;base64," + base64.b64encode(_png((1, 2, 3))).decode()
    err(env.call("u_ann", "POST", "/media", json={**body, "data_uri": other}), 409, "IDEMPOTENCY_CONFLICT")
    fake = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 40).decode()
    err(env.call("u_ann", "POST", "/media", json={**body, "data_uri": fake, "client_request_id": "direct-0002"}),
        422, "VALIDATION_FAILED")
    err(env.call("u_ann", "POST", "/media", json={**body, "data_uri": "data:text/plain;base64,aGk=",
                                                  "client_request_id": "direct-0003"}), 422, "VALIDATION_FAILED")
    sent = ok(env.call("u_ann", "POST", f"/conversations/{conv}/messages",
                       json={"media_ids": [first["media_id"]], "client_message_id": "direct-msg-0001"}), 201)
    assert sent["message"]["media"] == [{"media_id": first["media_id"]}]
    ok(env.call("u_ben", "GET", f"/media/{first['media_id']}/access"))
    err(env.call("u_cat", "GET", f"/media/{first['media_id']}/access"), 404, "NOT_FOUND_OR_NOT_ACCESSIBLE")
