"""The one way the backend sends mail: SMTP, configured by environment.

Every transactional provider worth considering — Gmail, SES, Resend, Brevo,
Aliyun DirectMail — speaks SMTP, so choosing or changing one is four
environment variables and no code. Gmail with an app password is what runs
today: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_USER=<the address>,
SMTP_PASSWORD=<the 16-character app password>.

Imports only `runtime`, like `runtime` itself imports nothing: main.py and
the verification module both reach this without a cycle.
"""

from __future__ import annotations

import os
import smtplib
import ssl
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, parseaddr

from backend import runtime

#: A stalled SMTP handshake must not hold a serverless worker until the
#: platform kills it; the caller turns a timeout into a retryable error.
SMTP_TIMEOUT_S = float(os.getenv("SMTP_TIMEOUT_S", "15"))


class MailNotConfigured(RuntimeError):
    """A deployed environment was asked to send mail it has no account for."""


def is_configured() -> bool:
    return bool(runtime.SMTP_USER and runtime.SMTP_PASSWORD)


def is_deployed() -> bool:
    """Vercel Preview and Production — anywhere a real person is waiting."""
    return (os.getenv("VERCEL_ENV") or "").strip().lower() in {"preview", "production"}


def _sender() -> tuple[str, str]:
    """(header From, envelope address).

    SMTP_FROM may carry a display name — `NURI <nuri.app@gmail.com>` — which
    belongs in the header but not in MAIL FROM, where a server expects a bare
    address. Gmail also rewrites any From that is not the authenticated
    account, so the default is the account itself.
    """
    configured = runtime.SMTP_FROM or runtime.SMTP_USER
    name, address = parseaddr(configured)
    address = address or runtime.SMTP_USER
    # formataddr RFC 2047-encodes a non-ASCII name itself.
    header = formataddr((name, address)) if name else address
    return header, address


def send_smtp(to_addr: str, subject: str, body: str) -> None:
    header_from, envelope_from = _sender()
    msg = MIMEMultipart()
    msg["Subject"] = Header(subject, "utf-8").encode()
    msg["From"] = header_from
    msg["To"] = to_addr
    msg.attach(MIMEText(body, "plain", "utf-8"))
    raw = msg.as_bytes()

    ctx = ssl.create_default_context()
    if runtime.SMTP_PORT == 465:
        with smtplib.SMTP_SSL(
            runtime.SMTP_HOST, runtime.SMTP_PORT, context=ctx, timeout=SMTP_TIMEOUT_S,
        ) as s:
            s.login(runtime.SMTP_USER, runtime.SMTP_PASSWORD)
            s.sendmail(envelope_from, to_addr, raw)
    else:
        with smtplib.SMTP(runtime.SMTP_HOST, runtime.SMTP_PORT, timeout=SMTP_TIMEOUT_S) as s:
            s.ehlo()
            s.starttls(context=ctx)
            s.login(runtime.SMTP_USER, runtime.SMTP_PASSWORD)
            s.sendmail(envelope_from, to_addr, raw)
