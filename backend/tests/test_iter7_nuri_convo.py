"""Iteration 7: Nuri single perpetual conversation backend tests.

Covers:
- GET /api/conversation creates/returns single convo per user
- POST /api/conversation/open-topic appends opener; is idempotent (no dup opener)
- POST /api/conversation/messages: script advance (reply1 text, reply2 status+text+task_cards, reply3 text, then fallback rotation)
- POST /api/conversation/tasks: add-plan creates task in /api/tasks; second add returns already=True
- card_bilingual_school & card_baby_monitor also produce task_cards on step 2
"""

import os
import time
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def auth_client():
    """Register a fresh user for this iteration; return session with bearer token."""
    ts = int(time.time() * 1000)
    email = f"e2e_nuri_{ts}@x.com"
    password = "test1234"
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    token = r.json()["access_token"]
    s.headers["Authorization"] = f"Bearer {token}"
    s.email = email  # type: ignore[attr-defined]
    return s


class TestConversationBase:
    def test_get_creates_empty_conversation(self, auth_client):
        r = auth_client.get(f"{API}/conversation")
        assert r.status_code == 200
        data = r.json()
        assert "id" in data
        assert isinstance(data["messages"], list)
        assert data["messages"] == []

    def test_get_returns_same_conversation(self, auth_client):
        r1 = auth_client.get(f"{API}/conversation")
        r2 = auth_client.get(f"{API}/conversation")
        assert r1.json()["id"] == r2.json()["id"]


class TestOpenTopic:
    def test_open_topic_food_picky_appends_opener(self, auth_client):
        r = auth_client.post(
            f"{API}/conversation/open-topic",
            json={"card_id": "card_food_picky"},
        )
        assert r.status_code == 200, r.text
        appended = r.json()["messages"]
        assert len(appended) == 1
        m = appended[0]
        assert m["role"] == "ai"
        assert m["type"] == "text"
        # opener must mention card title
        assert "18个月宝宝突然只吃3种食物" in m["content"]

    def test_open_topic_idempotent_no_duplicate(self, auth_client):
        # Call again with SAME card_id → should NOT append duplicate opener
        r = auth_client.post(
            f"{API}/conversation/open-topic",
            json={"card_id": "card_food_picky"},
        )
        assert r.status_code == 200
        assert r.json()["messages"] == []

        # Verify only 1 opener in the convo
        convo = auth_client.get(f"{API}/conversation").json()
        openers = [m for m in convo["messages"] if m["role"] == "ai" and "18个月" in m["content"]]
        assert len(openers) == 1


class TestScriptFlow:
    """Send messages and verify script-driven replies for card_food_picky (tip_food)."""

    def test_step1_food_neophobia_text(self, auth_client):
        r = auth_client.post(
            f"{API}/conversation/messages",
            json={"content": "宝宝只吃三种"},
        )
        assert r.status_code == 200
        ai = r.json()["ai_messages"]
        assert len(ai) == 1
        assert ai[0]["type"] == "text"
        assert "Food Neophobia" in ai[0]["content"]

    def test_step2_status_text_and_task_cards(self, auth_client):
        r = auth_client.post(
            f"{API}/conversation/messages",
            json={"content": "米饭 面条 酸奶"},
        )
        assert r.status_code == 200
        ai = r.json()["ai_messages"]
        # status + text + task_cards
        types = [m["type"] for m in ai]
        assert types == ["status", "text", "task_cards"], types
        assert "正在为您检索" in ai[0]["content"]
        assert "Nuri为你整理出了2条辅食打卡计划" in ai[1]["content"]
        cards = ai[2]["task_cards"]
        assert len(cards) == 2
        titles = [c["title"] for c in cards]
        assert "尝试鲜虾粥并观察宝宝食欲" in titles
        assert "记录宝宝今日接受的新食材" in titles
        # store card message id for add-task test
        pytest.food_task_message_id = ai[2]["id"]

    def test_step3_shrimp_answer(self, auth_client):
        r = auth_client.post(
            f"{API}/conversation/messages",
            json={"content": "虾头怎么处理"},
        )
        assert r.status_code == 200
        ai = r.json()["ai_messages"]
        assert len(ai) == 1
        assert "虾" in ai[0]["content"]

    def test_step4_fallback_rotation(self, auth_client):
        r = auth_client.post(
            f"{API}/conversation/messages",
            json={"content": "还有别的建议吗"},
        )
        ai = r.json()["ai_messages"]
        assert len(ai) == 1
        # fallback text — one of CONVO_FALLBACKS
        assert ai[0]["type"] == "text"
        assert ai[0]["content"] in [
            "嗯，我先记下了。你随时回来继续，我会保持上下文。",
            "我在呢。可以再多说一点，比如宝宝的月龄和最近一周的变化。",
            "收到。需要的话，我可以把这个整理成一个小任务加进你的计划里。",
        ]


class TestAddTaskFromCard:
    def test_add_first_task_creates_task(self, auth_client):
        msg_id = pytest.food_task_message_id
        r = auth_client.post(
            f"{API}/conversation/tasks",
            json={"message_id": msg_id, "card_index": 0},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert "task_id" in body
        pytest.added_task_id = body["task_id"]

    def test_task_appears_in_tasks_list(self, auth_client):
        r = auth_client.get(f"{API}/tasks")
        assert r.status_code == 200
        tasks = r.json()
        ids = [t["id"] for t in tasks]
        assert pytest.added_task_id in ids
        added = next(t for t in tasks if t["id"] == pytest.added_task_id)
        assert added["title"] == "尝试鲜虾粥并观察宝宝食欲"
        assert "来自你和Nuri的对话" in added["source"]

    def test_second_add_returns_already(self, auth_client):
        msg_id = pytest.food_task_message_id
        r = auth_client.post(
            f"{API}/conversation/tasks",
            json={"message_id": msg_id, "card_index": 0},
        )
        assert r.status_code == 200
        body = r.json()
        assert body.get("already") is True
        # no duplicate task
        tasks = auth_client.get(f"{API}/tasks").json()
        same_title = [t for t in tasks if t["title"] == "尝试鲜虾粥并观察宝宝食欲"]
        assert len(same_title) == 1

    def test_added_flag_persists_in_conversation(self, auth_client):
        convo = auth_client.get(f"{API}/conversation").json()
        target = next(m for m in convo["messages"] if m["id"] == pytest.food_task_message_id)
        assert target["task_cards"][0]["added"] is True
        assert target["task_cards"][1]["added"] is False


class TestOtherScripts:
    """card_bilingual_school + card_baby_monitor also produce task_cards on step 2."""

    def _fresh_user(self):
        ts = int(time.time() * 1000)
        s = requests.Session()
        s.headers.update({"Content-Type": "application/json"})
        r = s.post(
            f"{API}/auth/register",
            json={"email": f"e2e_scripts_{ts}@x.com", "password": "test1234"},
        )
        assert r.status_code == 201
        s.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        return s

    def test_bilingual_school_step2_has_task_cards(self):
        s = self._fresh_user()
        r = s.post(f"{API}/conversation/open-topic", json={"card_id": "card_bilingual_school"})
        assert r.status_code == 200
        assert "双语学校" in r.json()["messages"][0]["content"]
        # step 1
        s.post(f"{API}/conversation/messages", json={"content": "还在纠结"})
        # step 2
        r2 = s.post(f"{API}/conversation/messages", json={"content": "英文学术深度"})
        ai = r2.json()["ai_messages"]
        types = [m["type"] for m in ai]
        assert "task_cards" in types
        tc_msg = next(m for m in ai if m["type"] == "task_cards")
        assert len(tc_msg["task_cards"]) == 2
        titles = [c["title"] for c in tc_msg["task_cards"]]
        assert "和伴侣列出你们最在意的3件事" in titles

    def test_baby_monitor_step2_has_task_cards(self):
        s = self._fresh_user()
        r = s.post(f"{API}/conversation/open-topic", json={"card_id": "card_baby_monitor"})
        assert r.status_code == 200
        assert "婴儿监视器" in r.json()["messages"][0]["content"]
        s.post(f"{API}/conversation/messages", json={"content": "会爬了"})
        r2 = s.post(f"{API}/conversation/messages", json={"content": "上云问题"})
        ai = r2.json()["ai_messages"]
        tc_msg = next(m for m in ai if m["type"] == "task_cards")
        assert len(tc_msg["task_cards"]) == 2
        titles = [c["title"] for c in tc_msg["task_cards"]]
        assert "对比 Nanit / Owlet / VTech 的隐私政策" in titles


class TestErrorCases:
    def test_add_task_invalid_message_id(self, auth_client):
        r = auth_client.post(
            f"{API}/conversation/tasks",
            json={"message_id": "does-not-exist", "card_index": 0},
        )
        assert r.status_code == 404

    def test_send_empty_content_rejected(self, auth_client):
        r = auth_client.post(f"{API}/conversation/messages", json={"content": ""})
        assert r.status_code == 422
