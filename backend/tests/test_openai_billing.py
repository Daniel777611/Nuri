"""The /admin billing panel: OpenAI's own Costs and Usage APIs. No network."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx
from fastapi.testclient import TestClient

from backend import main, openai_billing as ob, runtime

# 2026-09-14 15:00 UTC; the month started 13 days ago.
NOW = datetime(2026, 9, 14, 15, 0, tzinfo=timezone.utc)


def _ts(day: int, month: int = 9) -> int:
    return int(datetime(2026, month, day, tzinfo=timezone.utc).timestamp())


def _cost(day, usd, project="proj_prod", line="gpt-5.5, input", **extra):
    return {"object": "bucket", "start_time": _ts(day), "end_time": _ts(day) + 86400, "results": [
        {"object": "organization.costs.result", "amount": {"value": usd, "currency": "usd"},
         "line_item": line, "project_id": project, **extra},
    ]}


def _usage(day, inp, out, cached=0, requests=1):
    return {"object": "bucket", "start_time": _ts(day), "end_time": _ts(day) + 86400, "results": [
        {"object": "organization.usage.completions.result", "input_tokens": inp, "output_tokens": out,
         "input_cached_tokens": cached, "num_model_requests": requests},
    ]}


def _raw():
    return ob.Raw(
        costs=[
            _cost(2, 5.0),                              # this month, before a 7-day window
            _cost(10, 1.0),
            _cost(13, 2.0, project=None, line="gpt-5-mini, output"),
            _cost(14, 0.5, project="proj_eval", project_name="nuri-eval"),
        ],
        usage=[_usage(13, 1000, 200, cached=400, requests=3), _usage(14, 500, 100, requests=2), _usage(1, 9, 9)],
        projects={"proj_prod": "nuri-prod"},
    )


def test_totals_split_the_window_from_the_month():
    out = ob.summarize(_raw(), days=7, now=NOW, turns=70, logged_by_day={"2026-09-13": 900, "2026-09-02": 50})
    assert out["since"] == "2026-09-08" and out["until"] == "2026-09-14"
    assert len(out["daily"]) == 7
    assert out["total_usd"] == 3.5
    assert out["month_to_date_usd"] == 8.5
    assert out["usd_per_turn"] == 0.05
    assert out["target_usd_per_turn"] == 0.0167


def test_projects_are_named_from_the_result_the_lookup_or_as_unassigned():
    names = {p["name"]: p["usd"] for p in ob.summarize(_raw(), days=7, now=NOW)["projects"]}
    assert names == {ob.UNASSIGNED_PROJECT: 2.0, "nuri-prod": 1.0, "nuri-eval": 0.5}


def test_line_items_are_ranked_and_the_tail_is_folded():
    raw = ob.Raw(costs=[_cost(14, float(i), line=f"item {i}") for i in range(1, 12)], usage=[], projects={})
    lines = ob.summarize(raw, days=1, now=NOW)["line_items"]
    assert [line["name"] for line in lines[:2]] == ["item 11", "item 10"]
    assert len(lines) == ob.TOP_LINE_ITEMS + 1
    assert lines[-1] == {"name": ob.OTHER_LINE_ITEM, "usd": 6.0, "share": round(6 / 66, 4)}


def test_unlogged_tokens_compare_the_bill_with_this_databases_logs():
    out = ob.summarize(_raw(), days=7, now=NOW, logged_by_day={"2026-09-13": 900, "2026-09-02": 50})
    assert out["usage"]["input_tokens"] == 1500  # the Sept 1 bucket is outside the window
    assert out["usage"]["cached_share"] == round(400 / 1500, 4)
    assert out["logged"] == {"tokens": 900, "unlogged_tokens": 900, "unlogged_share": 0.5}
    day13 = next(d for d in out["daily"] if d["day"] == "2026-09-13")
    assert day13 == {"day": "2026-09-13", "usd": 2.0, "input_tokens": 1000, "output_tokens": 200,
                     "cached_tokens": 400, "requests": 3, "logged_tokens": 900}


def test_no_turns_and_no_logs_leave_those_figures_empty():
    out = ob.summarize(_raw(), days=7, now=NOW, turns=0, logged_by_day=None)
    assert out["usd_per_turn"] is None
    assert out["logged"] is None


def test_a_bare_number_amount_is_read_too():
    raw = ob.Raw(costs=[{"start_time": _ts(14), "results": [{"amount": 1.25, "line_item": "x"}]}], usage=[], projects={})
    assert ob.summarize(raw, days=1, now=NOW)["total_usd"] == 1.25


# ── Fetching ─────────────────────────────────────────────────────────────────

def _transport(seen: list, *, costs_status=200, projects_status=200):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        assert request.headers["Authorization"] == "Bearer sk-admin-test"
        path = request.url.path
        if path.endswith("/costs"):
            if costs_status != 200:
                return httpx.Response(costs_status, text="nope")
            if request.url.params.get("page") == "p2":
                return httpx.Response(200, json={"data": [_cost(14, 2.0)], "has_more": False, "next_page": None})
            return httpx.Response(200, json={"data": [_cost(13, 1.0)], "has_more": True, "next_page": "p2"})
        if path.endswith("/usage/completions"):
            return httpx.Response(200, json={"data": [_usage(14, 10, 5)], "has_more": False, "next_page": None})
        if path.endswith("/projects"):
            if projects_status != 200:
                return httpx.Response(projects_status)
            return httpx.Response(200, json={"object": "list", "data": [{"id": "proj_prod", "name": "nuri-prod"}],
                                             "has_more": False, "last_id": "proj_prod"})
        return httpx.Response(404)
    return httpx.MockTransport(handler)


def _fetch(transport, **kw):
    return asyncio.run(ob.fetch_openai("sk-admin-test", days=7, now=NOW, transport=transport, **kw))


def test_fetch_follows_pages_and_groups_costs(monkeypatch):
    monkeypatch.setattr(ob, "_CACHE", {})
    seen: list = []
    raw = _fetch(_transport(seen))
    assert [b["start_time"] for b in raw.costs] == [_ts(13), _ts(14)]
    assert raw.projects == {"proj_prod": "nuri-prod"}
    first_costs = next(r for r in seen if r.url.path.endswith("/costs"))
    assert first_costs.url.params.get_list("group_by") == ["project_id", "line_item"]
    assert first_costs.url.params["bucket_width"] == "1d"
    # Month-to-date: costs start on the 1st even though the window starts on the 8th.
    assert int(first_costs.url.params["start_time"]) == _ts(1)
    usage = next(r for r in seen if r.url.path.endswith("/usage/completions"))
    assert int(usage.url.params["start_time"]) == _ts(8)


def test_fetch_is_cached_until_refreshed(monkeypatch):
    monkeypatch.setattr(ob, "_CACHE", {})
    seen: list = []
    _fetch(_transport(seen))
    calls = len(seen)
    _fetch(_transport(seen))
    assert len(seen) == calls
    _fetch(_transport(seen), refresh=True)
    assert len(seen) > calls


def test_a_rejected_key_is_explained(monkeypatch):
    monkeypatch.setattr(ob, "_CACHE", {})
    try:
        _fetch(_transport([], costs_status=401))
    except ob.BillingError as exc:
        assert exc.status == 401
        assert "401" in str(exc) and "sk-admin" not in str(exc)
    else:
        raise AssertionError("expected BillingError")


def test_a_failed_project_lookup_only_costs_the_names(monkeypatch):
    monkeypatch.setattr(ob, "_CACHE", {})
    raw = _fetch(_transport([], projects_status=403))
    assert raw.projects == {}
    assert len(raw.costs) == 2


def test_spaces_in_the_admin_key_are_ignored(monkeypatch):
    monkeypatch.setenv("OPENAI_ADMIN_KEY", " sk-admin-abc\n")
    assert ob.admin_key() == "sk-admin-abc"


# ── Route ────────────────────────────────────────────────────────────────────

def test_route_needs_the_admin_key_and_reports_a_missing_billing_key(monkeypatch):
    monkeypatch.setattr(main, "ADMIN_KEY", "k")
    monkeypatch.delenv("OPENAI_ADMIN_KEY", raising=False)
    client = TestClient(main.app)
    assert client.get("/admin/usage/costs").status_code == 403
    res = client.get("/admin/usage/costs", headers={"x-admin-key": "k"})
    assert res.status_code == 200
    assert res.json() == {"configured": False}


def test_route_combines_the_bill_with_this_databases_logs(monkeypatch):
    monkeypatch.setattr(main, "ADMIN_KEY", "k")
    monkeypatch.setenv("OPENAI_ADMIN_KEY", "sk-admin-test")
    seen = {}

    async def fake_fetch(key, *, days, now, refresh=False, transport=None):
        seen.update(key=key, days=days, refresh=refresh)
        return _raw()

    monkeypatch.setattr(ob, "fetch_openai", fake_fetch)
    monkeypatch.setattr(ob, "fetch_logged", lambda sb, since: (7, {}, ["llm_call_logs"]))
    monkeypatch.setattr(runtime, "get_supabase", lambda: object())
    res = TestClient(main.app).get("/admin/usage/costs?days=500&refresh=true", headers={"x-admin-key": "k"})
    assert res.status_code == 200
    body = res.json()
    assert seen == {"key": "sk-admin-test", "days": ob.MAX_DAYS, "refresh": True}
    assert body["configured"] is True and body["turns"] == 7
    assert body["truncated"] == ["llm_call_logs"]


def test_route_turns_an_openai_refusal_into_a_502(monkeypatch):
    monkeypatch.setattr(main, "ADMIN_KEY", "k")
    monkeypatch.setenv("OPENAI_ADMIN_KEY", "sk-admin-test")

    async def refused(*_a, **_k):
        raise ob.BillingError("OpenAI 拒绝了这把 Admin 密钥（401）", 401)

    monkeypatch.setattr(ob, "fetch_openai", refused)
    res = TestClient(main.app).get("/admin/usage/costs", headers={"x-admin-key": "k"})
    assert res.status_code == 502
    assert "401" in res.json()["detail"]
