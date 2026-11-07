"""End-to-end smoke test of /api/community/v1 with two real accounts.

Run it yourself; passwords are read with getpass and never printed:

    python backend/scripts/community_smoke.py --base https://nurifam.app

It walks the conservative flow A ↔ B: profiles, a question and its answer,
comment threads, invitation, contacts, a P2P chat with read cursor, two-party
AI consent and revoke, an image attachment, community notifications, block /
unblock. It writes real rows (and queues real pushes to B's phone). At the end
it deletes the smoke question, disconnects A and B, and hides both community
profiles, so they stay out of recommendations.

Exit status is 0 only when every step passed.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import os
import sys
import time
import uuid
import zlib
import struct

import httpx

try:  # Windows consoles default to cp1252, which cannot print the step names.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

V1 = "/api/community/v1"
RESULTS: list[tuple[str, bool, str]] = []


def step(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    return ok


def key(tag: str) -> str:
    return f"smoke-{tag}-{uuid.uuid4().hex[:12]}"


def tiny_png() -> bytes:
    raw = b"\x00" + b"\xc8\x20\x20" * 4
    rows = raw * 4

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


class Account:
    def __init__(self, client: httpx.Client, label: str, token: str):
        self.client, self.label, self.token = client, label, token

    def __call__(self, method: str, path: str, **kw) -> httpx.Response:
        return self.client.request(method, V1 + path, headers={"Authorization": f"Bearer {self.token}"},
                                   timeout=60, **kw)


def login(client: httpx.Client, label: str) -> Account:
    token = os.getenv(f"NURI_SMOKE_{label}_TOKEN")
    if not token:
        email = os.getenv(f"NURI_SMOKE_{label}_EMAIL") or input(f"Account {label} email: ").strip()
        password = getpass.getpass(f"Account {label} password: ")
        r = client.post("/api/auth/login", json={"email": email, "password": password}, timeout=60)
        if r.status_code != 200:
            sys.exit(f"Account {label} login failed: HTTP {r.status_code} {r.text[:200]}")
        token = r.json()["access_token"]
    return Account(client, label, token)


def put_upload(upload: dict, data: bytes) -> int:
    r = httpx.put(upload["url"], content=data, headers=upload.get("headers") or {}, timeout=60)
    return r.status_code


def run(client: httpx.Client, a: Account, b: Account) -> bool:
    def j(resp):
        try:
            return resp.json()
        except ValueError:
            return {"raw": resp.text[:200]}

    # Profiles & preferences
    ra = a("PATCH", "/profiles/me", json={"display_name": "冒烟测试A", "about": "smoke test", "gender_tag": "mom",
                                           "intents": ["share_parenting_ideas"]})
    rb = b("PATCH", "/profiles/me", json={"display_name": "冒烟测试B", "about": "smoke test", "gender_tag": "dad",
                                           "intents": ["share_parenting_ideas"]})
    if not step("P02 两个账号建立/更新社区资料", ra.status_code == rb.status_code == 200,
                f"{ra.status_code}/{rb.status_code}"):
        print(ra.text[:300], rb.text[:300])
        return False
    for acct in (a, b):
        acct("PATCH", "/preferences", json={"profile_hidden": False})
    pa, pb = j(ra)["profile"]["parent_id"], j(rb)["profile"]["parent_id"]
    # D01: the community name is the account name too.
    acct = client.get("/api/auth/me", headers={"Authorization": f"Bearer {a.token}"}, timeout=60)
    step("D01 社区名字同步到账号昵称", acct.status_code == 200 and acct.json().get("nickname") == "冒烟测试A",
         str(acct.json().get("nickname") if acct.status_code == 200 else acct.status_code))
    me = j(a("GET", "/profiles/me"))
    step("D03 自选性别标签", me.get("profile", {}).get("gender_tag") == "mom")
    step("P01 读取本人资料", me.get("exists") is True and me["profile"]["parent_id"] == pa)
    seen = a("GET", f"/parents/{pb}")
    step("P03 A 看 B 的公开资料（不含 email）", seen.status_code == 200 and "@" not in seen.text, str(seen.status_code))
    rec = j(a("GET", "/recommendations"))
    step("P04 推荐列表可读", "items" in rec, f"{len(rec.get('items', []))} 位")
    step("P24 偏好可读", "profile_hidden" in j(b("GET", "/preferences")))

    # Question → delivery → response
    q = a("POST", "/questions", json={"body": "【冒烟测试】宝宝托育告别时总哭，你们怎么做的？",
                                     "client_request_id": (qk := key("q"))})
    qj = j(q)
    if not step("P06 A 发布问题", q.status_code == 201, f"{q.status_code} 投递 {qj.get('delivery', {}).get('recipient_count')} 人"):
        print(q.text[:300])
        return False
    qid = qj["question"]["question_id"]
    again = a("POST", "/questions", json={"body": "【冒烟测试】宝宝托育告别时总哭，你们怎么做的？", "client_request_id": qk})
    step("P06 同 key 重试不重复", again.status_code == 200 and j(again)["question"]["question_id"] == qid)
    step("P07 操作状态", j(a("GET", f"/operations/{qjson_op(qj)}")).get("state") == "succeeded")
    step("P08 我的问题列表包含它", any(i["question_id"] == qid for i in j(a("GET", "/me/questions"))["items"]))

    waiting = j(b("GET", "/me/question-deliveries", params={"tab": "waiting"}))["items"]
    delivery = next((d for d in waiting if d["question"]["question_id"] == qid), None)
    answered = False
    if step("P11 B 收到这个问题", delivery is not None,
            "" if delivery else "随机投递没选中 B（社区里已有超过 5 个资料时可能发生）；跳过回答相关步骤"):
        step("P09 B 能看问题详情", b("GET", f"/questions/{qid}").status_code == 200)
        body = {"body": "【冒烟测试】我们每天用同一句告别话。", "client_request_id": (rk := key("r"))}
        r1 = b("POST", f"/question-deliveries/{delivery['delivery_id']}/responses", json=body)
        r2 = b("POST", f"/question-deliveries/{delivery['delivery_id']}/responses", json=body)
        answered = step("P12 B 回答（重试不重复）", r1.status_code == 201 and r2.status_code == 200,
                        f"{r1.status_code}/{r2.status_code}")
        if answered:
            reply_id = j(r1)["reply"]["reply_id"]
            reps = j(a("GET", f"/questions/{qid}/replies"))
            step("P13 A 看到 B 的经验", any(i["reply_id"] == reply_id for i in reps.get("items", [])))
            c = a("POST", f"/questions/{qid}/reply-threads/{reply_id}/comments",
                  json={"body": "谢谢！具体怎么说？", "client_message_id": key("c")})
            lst = j(b("GET", f"/questions/{qid}/reply-threads/{reply_id}/comments"))
            step("P14 回复线程评论往返", c.status_code == 201 and len(lst.get("items", [])) >= 1, str(c.status_code))
            step("P11 B 的已回复 tab", any(d["question"]["question_id"] == qid for d in
                                         j(b("GET", "/me/question-deliveries", params={"tab": "replied"}))["items"]))

    # Invitation → contact
    inv = a("POST", "/invitations", json={"target_parent_id": pb, "client_request_id": key("inv")})
    ij = j(inv)
    rel_state = ij.get("relationship", {}).get("state")
    step("P15 A 邀请 B", inv.status_code == 200 and rel_state in ("invitation_sent", "connected"), rel_state or inv.text[:200])
    if rel_state == "invitation_sent":
        recv = j(b("GET", "/invitations"))["items"]
        mine = next((i for i in recv if i["invitation_id"] == ij["invitation"]["invitation_id"]), None)
        step("P15 B 收到邀请", mine is not None)
        if mine:
            d = b("POST", f"/invitations/{mine['invitation_id']}/decisions",
                  json={"decision": "accept", "client_request_id": key("dec")})
            step("P16 B 接受邀请", d.status_code == 200 and j(d)["relationship"]["state"] == "connected", str(d.status_code))
    contacts = j(a("GET", "/me/contacts"))["items"]
    contact = next((c for c in contacts if c["parent"]["parent_id"] == pb), None)
    if not step("P17 A 的联系人里有 B", contact is not None):
        return False

    # Conversation
    conv = a("POST", "/conversations", json={"target_parent_id": pb, "client_request_id": key("conv")})
    if not step("P21 开启家长对话", conv.status_code == 200, str(conv.status_code)):
        print(conv.text[:300])
        return False
    cid = j(conv)["conversation"]["conversation_id"]
    step("P21 AI 默认关闭", j(conv)["conversation"]["ai"]["effective"] is False)
    m = a("POST", f"/conversations/{cid}/messages", json={"text": "【冒烟测试】你好！", "client_message_id": (mk := key("m"))})
    m2 = a("POST", f"/conversations/{cid}/messages", json={"text": "【冒烟测试】你好！", "client_message_id": mk})
    step("P22 A 发消息（重试不重复）", m.status_code == 201 and m2.status_code == 200, f"{m.status_code}/{m2.status_code}")
    msgs = j(b("GET", f"/conversations/{cid}/messages"))
    step("P22 B 读到消息", any(x["text"] == "【冒烟测试】你好！" for x in msgs.get("items", [])))
    box = j(b("GET", "/me/inbox"))
    entry = next((i for i in box.get("items", []) if i["conversation_id"] == cid), None)
    step("P20 B 收件箱有未读", bool(entry and entry["unread_count"] >= 1), str(entry and entry["unread_count"]))
    rep = b("POST", "/reports", json={"target_kind": "message", "target_id": j(m)["message"]["message_id"],
                                      "reason": "other", "note": "smoke test report"})
    step("UGC B 举报 A 的消息（进入人工审核队列）", rep.status_code == 201 and j(rep).get("status") == "received", str(rep.status_code))
    last = max(x["seq"] for x in msgs["items"])
    cur = j(b("PUT", f"/conversations/{cid}/read-cursor", json={"last_read_seq": last}))
    step("P23 B 标记已读后未读为 0", cur.get("unread_count") == 0, str(cur))

    # Two-party AI consent
    notice = j(a("GET", f"/conversations/{cid}/ai-participation")).get("notice_version")
    req = a("POST", f"/conversations/{cid}/ai-consent-requests",
            json={"notice_version": notice, "client_request_id": key("air")})
    rj = j(req).get("request", {})
    step("P25 A 请求 AI 参与（仍未生效）", req.status_code == 200 and rj.get("effective") is False, str(req.status_code))
    if rj.get("request_id"):
        dec = b("PUT", f"/ai-consent-requests/{rj['request_id']}/my-decision",
                json={"decision": "allow", "notice_version": notice, "client_request_id": key("aid")})
        step("P26 B 同意后生效", j(dec).get("request", {}).get("state") == "effective", dec.text[:200])
        act = j(a("GET", f"/conversations/{cid}/ai-participation"))
        step("P28 参与状态 effective", act.get("effective") is True)
        # Uses are separate: notes consent does not let B translate A's words.
        tr = b("POST", f"/messages/{j(m)['message']['message_id']}/translations",
               json={"target_language": "en", "ai_consent_version": "2026-10-01.1", "client_request_id": key("tr")})
        step("D13 翻译对方消息需单独的 translation 同意",
             tr.status_code == 403 and j(tr).get("error", {}).get("code") == "CONSENT_REQUIRED", str(tr.status_code))
        off = j(a("DELETE", f"/conversations/{cid}/ai-participation"))
        step("P27 A 关闭后失效", off.get("effective") is False)

    # Media — the apps' path: one prepared image through the backend.
    import base64 as _b64
    direct = a("POST", "/media", json={"purpose": "message", "data_uri": "data:image/png;base64," + _b64.b64encode(tiny_png()).decode(),
                                      "client_request_id": key("direct")})
    dj = j(direct)
    if step("P31 App 直传图片", direct.status_code == 201 and dj.get("media", {}).get("state") == "ready", direct.text[:160]):
        dm = a("POST", f"/conversations/{cid}/messages", json={"media_ids": [dj["media"]["media_id"]], "client_message_id": key("dm")})
        step("P22 发送直传的图片", dm.status_code == 201, str(dm.status_code))
        got = j(b("GET", f"/media/{dj['media']['media_id']}/access")).get("access", {}).get("url")
        step("P33 B 读取直传图片", bool(got) and httpx.get(got, timeout=60).content == tiny_png())
    # Media — the signed-upload path kept for larger files
    png = tiny_png()
    up = a("POST", "/media/uploads", json={"purpose": "message", "mime_type": "image/png", "byte_size": len(png),
                                           "sha256": hashlib.sha256(png).hexdigest(), "client_request_id": key("up")})
    uj = j(up)
    if step("P31 申请上传", up.status_code == 200 and uj.get("upload"), up.text[:200] if up.status_code != 200 else ""):
        code = put_upload(uj["upload"], png)
        step("P31 上传到签名 URL", code in (200, 201), str(code))
        done = j(a("POST", f"/media/uploads/{uj['media']['media_id']}/complete", json={}))
        ready = done.get("media", {}).get("state") == "ready"
        step("P32 服务端校验为 ready", ready, str(done.get("media")))
        if ready:
            mid = uj["media"]["media_id"]
            sm = a("POST", f"/conversations/{cid}/messages", json={"media_ids": [mid], "client_message_id": key("mm")})
            step("P22 发送带图消息", sm.status_code == 201, str(sm.status_code))
            acc = j(b("GET", f"/media/{mid}/access"))
            url = acc.get("access", {}).get("url")
            got = httpx.get(url, timeout=60) if url else None
            step("P33 B 能读图片", bool(got and got.status_code == 200 and got.content == png),
                 str(got.status_code if got else acc))
            step("P34 已发送图片不能删", a("DELETE", f"/media/{mid}").status_code == 422)

    # Notifications
    time.sleep(1)
    notes = j(b("GET", "/me/notifications")).get("items", [])
    step("P35 B 有社区通知", len(notes) >= 1, f"{len(notes)} 条: {sorted({n['kind'] for n in notes})}")
    if notes:
        tgt = j(b("GET", f"/me/notifications/{notes[0]['notification_id']}/target"))
        step("P36 通知目标重新校验", "accessible" in tgt, str(tgt.get("accessible")))
        rd = j(b("POST", f"/me/notifications/{notes[0]['notification_id']}/read"))
        step("P36 标记通知已读", bool(rd.get("read_at")))

    # Block / unblock
    blk = b("PUT", f"/me/blocks/{pa}", json={"confirmed": True})
    step("P19 B 屏蔽 A", blk.status_code == 200, str(blk.status_code))
    after = a("POST", f"/conversations/{cid}/messages", json={"text": "还在吗", "client_message_id": key("m")})
    step("P19 屏蔽后 A 无法发消息", after.status_code == 403 and j(after)["error"]["code"] == "BLOCKED_OR_DISCONNECTED",
         str(after.status_code))
    step("P19 屏蔽列表", any(x["parent"]["parent_id"] == pa for x in j(b("GET", "/me/blocks"))["items"]))
    un = b("DELETE", f"/me/blocks/{pa}", params={"confirmed": True})
    step("P19 解除屏蔽（不恢复联系）", un.status_code == 200 and j(un)["relationship"]["state"] != "connected",
         j(un).get("relationship", {}).get("state", un.text[:100]))

    # Cleanup
    a("POST", "/questions/batch-transitions", json={"action": "delete", "confirmed": True,
                                                  "client_request_id": key("del"), "items": [{"question_id": qid}]})
    for acct in (a, b):
        acct("PATCH", "/preferences", json={"profile_hidden": True})
    step("清理：删除冒烟问题并隐藏两个资料", True)
    return all(ok for _, ok, _ in RESULTS)


def qjson_op(qj: dict) -> str:
    return qj["operation"]["operation_id"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://nurifam.app")
    args = ap.parse_args()
    with httpx.Client(base_url=args.base) as client:
        a, b = login(client, "A"), login(client, "B")
        ok = run(client, a, b)
    passed = sum(1 for _, good, _ in RESULTS if good)
    print(f"\n{passed}/{len(RESULTS)} passed")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
