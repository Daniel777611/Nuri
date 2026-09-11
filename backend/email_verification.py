"""Proving an address belongs to the person typing it.

Three pieces, each small:

* `mailbox_problem` — a cheap pre-check before any mail is sent. It rejects
  domains that cannot receive mail (no MX, or a null MX like example.com) and
  a short list of throwaway-inbox services. Sending to a dead domain bounces,
  and bounces are what gets a Gmail sender throttled.
* `issue_code` / `check_code` — six-digit codes in `email_codes`. Only an
  HMAC of the code is stored. One live code per address and purpose; each
  allows five guesses and lives ten minutes, and an address can be sent at
  most one code a minute and five an hour.
* `send_code` — the mail itself, in the parent's language.

Every database call here is synchronous; route handlers run them through
`anyio.to_thread`, as they do every other Supabase call.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from email_validator import EmailNotValidError, EmailUndeliverableError, validate_email

from backend import mailer, runtime

Purpose = Literal["verify", "reset"]
CheckResult = Literal["ok", "wrong", "expired", "locked"]

CODE_TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5
RESEND_COOLDOWN_S = 60
MAX_SENDS_PER_HOUR = 5
#: Codes older than this are deleted whenever the address is sent a new one.
PRUNE_AFTER = timedelta(days=1)
DNS_TIMEOUT_S = 3

#: Not exhaustive and not meant to be: the code is what proves a mailbox. This
#: only stops the handful of services people reach for when a form asks for
#: an address they don't intend to keep.
DISPOSABLE_DOMAINS = frozenset({
    "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com",
    "10minutemail.com", "10minutemail.net", "temp-mail.org", "tempmail.com",
    "yopmail.com", "yopmail.net", "trashmail.com", "getnada.com", "dispostable.com",
    "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mintemail.com",
    "emailondeck.com", "mohmal.com", "tempail.com", "burnermail.io",
})


class CodeRateLimited(Exception):
    def __init__(self, retry_after: int):
        super().__init__(f"retry after {retry_after}s")
        self.retry_after = max(1, int(retry_after))


def normalize(email: str) -> str:
    return (email or "").strip().lower()


def mailbox_problem(email: str) -> Optional[Literal["invalid", "undeliverable", "disposable"]]:
    """Why this address can't be used, or None when it looks deliverable.

    A DNS timeout or resolver failure is *not* a reason to refuse: the code is
    the real proof, and a slow resolver must never block a registration.
    """
    domain = email.rsplit("@", 1)[-1]
    if domain in DISPOSABLE_DOMAINS:
        return "disposable"
    try:
        validate_email(email, check_deliverability=True, timeout=DNS_TIMEOUT_S)
    except EmailUndeliverableError:
        return "undeliverable"
    except EmailNotValidError:
        return "invalid"
    except Exception:
        return None
    return None


# ── Codes ────────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(ts: str) -> datetime:
    parsed = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _hash(email: str, purpose: str, code: str) -> str:
    # Keyed, so a leaked table can't be brute-forced offline: six digits is
    # only a million candidates.
    key = runtime.JWT_SECRET.encode("utf-8")
    return hmac.new(key, f"{purpose}:{email}:{code}".encode("utf-8"), hashlib.sha256).hexdigest()


def normalize_code(raw: str) -> str:
    return "".join(ch for ch in (raw or "") if ch.isdigit())


def issue_code(sb, email: str, purpose: Purpose) -> tuple[str, str]:
    """Create a new code for `email`; returns (row id, plaintext code).

    Raises CodeRateLimited when the address was sent a code too recently or
    too often. Any earlier live code for the same purpose is retired, so only
    the newest one in the inbox works.
    """
    now = _now()
    recent = (
        sb.table("email_codes").select("created_at")
        .eq("email", email).eq("purpose", purpose)
        .gte("created_at", (now - timedelta(hours=1)).isoformat())
        .order("created_at", desc=True)
        .execute()
    ).data or []
    if recent:
        since_last = (now - _parse(recent[0]["created_at"])).total_seconds()
        if since_last < RESEND_COOLDOWN_S:
            raise CodeRateLimited(math.ceil(RESEND_COOLDOWN_S - since_last))
        if len(recent) >= MAX_SENDS_PER_HOUR:
            oldest = _parse(recent[MAX_SENDS_PER_HOUR - 1]["created_at"])
            raise CodeRateLimited(math.ceil(3600 - (now - oldest).total_seconds()))

    sb.table("email_codes").delete().eq("email", email).lt(
        "created_at", (now - PRUNE_AFTER).isoformat()
    ).execute()
    sb.table("email_codes").update({"consumed_at": now.isoformat()}).eq(
        "email", email
    ).eq("purpose", purpose).is_("consumed_at", "null").execute()

    code = f"{secrets.randbelow(1_000_000):06d}"
    row_id = str(uuid.uuid4())
    sb.table("email_codes").insert({
        "id": row_id,
        "email": email,
        "purpose": purpose,
        "code_hash": _hash(email, purpose, code),
        "attempts": 0,
        "expires_at": (now + CODE_TTL).isoformat(),
        "created_at": now.isoformat(),
    }).execute()
    return row_id, code


def discard_code(sb, row_id: str) -> None:
    """Undo `issue_code` when the mail never left, so the cooldown doesn't
    make the parent wait a minute for a code they never received."""
    sb.table("email_codes").delete().eq("id", row_id).execute()


def check_code(sb, email: str, purpose: Purpose, raw_code: str) -> CheckResult:
    code = normalize_code(raw_code)
    rows = (
        sb.table("email_codes").select("*")
        .eq("email", email).eq("purpose", purpose).is_("consumed_at", "null")
        .order("created_at", desc=True).limit(1)
        .execute()
    ).data or []
    if not rows:
        return "expired"
    row = rows[0]
    now = _now()
    if _parse(row["expires_at"]) <= now:
        return "expired"
    attempts = int(row.get("attempts") or 0)
    if attempts >= MAX_ATTEMPTS:
        return "locked"
    if len(code) != 6 or not hmac.compare_digest(row["code_hash"], _hash(email, purpose, code)):
        attempts += 1
        sb.table("email_codes").update({"attempts": attempts}).eq("id", row["id"]).execute()
        return "locked" if attempts >= MAX_ATTEMPTS else "wrong"
    # Conditional on still being live, so two simultaneous submissions of the
    # same code can't both succeed.
    consumed = (
        sb.table("email_codes").update({"consumed_at": now.isoformat()})
        .eq("id", row["id"]).is_("consumed_at", "null")
        .execute()
    ).data
    return "ok" if consumed else "expired"


# ── Mail ─────────────────────────────────────────────────────────────────────

_MAIL = {
    "zh-CN": {
        "verify": ("NURI 邮箱验证码：{code}",
                   "你好！\n\n你正在注册 NURI，验证码是：\n\n    {code}\n\n"
                   "验证码 10 分钟内有效。如果这不是你本人的操作，请忽略这封邮件。\n\n— NURI"),
        "reset": ("NURI 重置密码验证码：{code}",
                  "你好！\n\n你正在重置 NURI 账户的密码，验证码是：\n\n    {code}\n\n"
                  "验证码 10 分钟内有效。如果你没有申请重置密码，请忽略这封邮件，你的密码不会被修改。\n\n— NURI"),
    },
    "zh-TW": {
        "verify": ("NURI 信箱驗證碼：{code}",
                   "你好！\n\n你正在註冊 NURI，驗證碼是：\n\n    {code}\n\n"
                   "驗證碼 10 分鐘內有效。如果這不是你本人的操作，請忽略這封郵件。\n\n— NURI"),
        "reset": ("NURI 重設密碼驗證碼：{code}",
                  "你好！\n\n你正在重設 NURI 帳戶的密碼，驗證碼是：\n\n    {code}\n\n"
                  "驗證碼 10 分鐘內有效。如果你沒有申請重設密碼，請忽略這封郵件，你的密碼不會被修改。\n\n— NURI"),
    },
    "en": {
        "verify": ("Your NURI verification code: {code}",
                   "Hi!\n\nYou're signing up for NURI. Your verification code is:\n\n    {code}\n\n"
                   "It expires in 10 minutes. If this wasn't you, you can ignore this email.\n\n— NURI"),
        "reset": ("Your NURI password reset code: {code}",
                  "Hi!\n\nYou asked to reset your NURI password. Your code is:\n\n    {code}\n\n"
                  "It expires in 10 minutes. If you didn't ask for this, ignore this email — "
                  "your password stays the same.\n\n— NURI"),
    },
}


def send_code(to_addr: str, code: str, purpose: Purpose, language: Optional[str] = None) -> None:
    """Send the code, or print it when running locally without SMTP.

    Raises MailNotConfigured on a deployment with no SMTP account — a code that
    only reaches a server log is a registration nobody can finish.
    """
    subject, body = _MAIL.get(language or "zh-CN", _MAIL["zh-CN"])[purpose]
    if not mailer.is_configured():
        if mailer.is_deployed():
            raise mailer.MailNotConfigured("SMTP_USER / SMTP_PASSWORD are not set")
        print(f"[dev] {purpose} code for {to_addr}: {code}  (SMTP not configured; not sent)")
        return
    mailer.send_smtp(to_addr, subject.format(code=code), body.format(code=code))
