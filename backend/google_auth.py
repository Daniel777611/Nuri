"""Sign in with Google: checking the ID token Google hands the browser.

The page runs Google Identity Services, which returns a signed ID token (a
JWT) once the parent picks an account. Nothing in it can be trusted until
this module has checked, against Google's published keys, that:

* Google signed it (RS256, a key from GOOGLE_CERTS_URL);
* it was issued to NURI — `aud` is one of GOOGLE_CLIENT_IDS — and not to some
  other site that is replaying a token its own users gave it;
* it is current (`exp`, `iat`), and comes from Google (`iss`);
* Google itself has verified the address (`email_verified`).

A verified Google address proves the mailbox exactly as NURI's emailed code
does, which is what lets main.google_login treat it as a verified account.

Configuration:
    GOOGLE_CLIENT_IDS   comma-separated OAuth client ids (web now; the iOS and
                        Android shells' ids join it when they sign in natively)
    GOOGLE_CLIENT_ID    accepted as a single-id fallback
"""

from __future__ import annotations

import os
from typing import Optional

import jwt

GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")
#: Clock skew allowed between Google and this server.
LEEWAY_S = 60

_jwks_client: Optional[jwt.PyJWKClient] = None


class GoogleTokenError(ValueError):
    """The token is not one this server can accept."""


def client_ids() -> list[str]:
    raw = os.getenv("GOOGLE_CLIENT_IDS") or os.getenv("GOOGLE_CLIENT_ID") or ""
    return [c.strip() for c in raw.split(",") if c.strip()]


def enabled() -> bool:
    return bool(client_ids())


def _signing_key(token: str):
    global _jwks_client
    if _jwks_client is None:
        # Keys are cached in-process; Google rotates them every few days and
        # the client refetches when it meets an unknown `kid`.
        _jwks_client = jwt.PyJWKClient(GOOGLE_CERTS_URL, cache_keys=True, lifespan=6 * 3600)
    return _jwks_client.get_signing_key_from_jwt(token).key


def verify_id_token(token: str) -> dict:
    """The token's claims, or GoogleTokenError. Blocking (it may fetch keys)."""
    audiences = client_ids()
    if not audiences:
        raise GoogleTokenError("google sign-in is not configured")
    if not token or token.count(".") != 2:
        raise GoogleTokenError("malformed token")
    try:
        key = _signing_key(token)
        claims = jwt.decode(
            token, key, algorithms=["RS256"], audience=audiences, issuer=list(GOOGLE_ISSUERS),
            leeway=LEEWAY_S, options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise GoogleTokenError(f"invalid token: {type(exc).__name__}") from exc
    email = str(claims.get("email") or "").strip()
    # Google sends a boolean; older tokens sent the string "true".
    if not email or claims.get("email_verified") not in (True, "true"):
        raise GoogleTokenError("google has not verified this address")
    return claims


def display_name(claims: dict) -> str:
    """A first name to pre-fill onboarding's nickname with."""
    name = str(claims.get("given_name") or claims.get("name") or "").strip()
    return name[:40]
