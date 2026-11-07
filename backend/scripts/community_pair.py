"""Connect or disconnect two test accounts in the live Community, for hands-on tests.

    python backend/scripts/community_pair.py connect    --base https://nurifam.app
    python backend/scripts/community_pair.py disconnect --base https://nurifam.app

connect: shows both community profiles, A invites B and B accepts, then prints
the state. disconnect: ends the connection and hides both profiles again.
Passwords are read with getpass and never printed or stored.
"""

from __future__ import annotations

import argparse
import sys
import uuid

import httpx

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from community_smoke import V1, Account, login  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


def key(tag: str) -> str:
    return f"pair-{tag}-{uuid.uuid4().hex[:12]}"


def connect(a: Account, b: Account) -> None:
    for acct in (a, b):
        acct("PATCH", "/preferences", json={"profile_hidden": False})
    pb = a("GET", "/profiles/me"), b("GET", "/profiles/me")
    if pb[1].status_code != 200 or not pb[1].json().get("exists"):
        sys.exit("Account B has no community profile yet; open Community on B once first.")
    b_id = pb[1].json()["profile"]["parent_id"]
    a("DELETE", f"/me/blocks/{b_id}", params={"confirmed": True})
    pa_id = pb[0].json()["profile"]["parent_id"]
    b("DELETE", f"/me/blocks/{pa_id}", params={"confirmed": True})
    inv = a("POST", "/invitations", json={"target_parent_id": b_id, "client_request_id": key("inv")}).json()
    state = inv.get("relationship", {}).get("state")
    if state == "invitation_sent":
        iid = inv["invitation"]["invitation_id"]
        b("POST", f"/invitations/{iid}/decisions", json={"decision": "accept", "client_request_id": key("dec")})
    final = a("GET", f"/parents/{b_id}").json().get("relationship", {}).get("state")
    print(f"A ↔ B relationship: {final}")
    print("Ready: sign in as A on the phone, open 社区 → 育儿好友 → 我的消息 / 通讯录 → B." if final == "connected"
          else "Not connected; paste this output to Claude.")


def disconnect(a: Account, b: Account) -> None:
    b_id = b("GET", "/profiles/me").json()["profile"]["parent_id"]
    rel = a("GET", f"/parents/{b_id}").json().get("relationship", {})
    if rel.get("state") == "connected" and rel.get("relationship_id"):
        a("DELETE", f"/relationships/{rel['relationship_id']}", params={"confirmed": True})
    for acct in (a, b):
        acct("PATCH", "/preferences", json={"profile_hidden": True})
    print("Disconnected and both profiles hidden.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["connect", "disconnect"])
    ap.add_argument("--base", default="https://nurifam.app")
    args = ap.parse_args()
    with httpx.Client(base_url=args.base) as client:
        a, b = login(client, "A"), login(client, "B")
        (connect if args.action == "connect" else disconnect)(a, b)


if __name__ == "__main__":
    main()
