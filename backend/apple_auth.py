"""Apple's provider boundary. Provider secrets and refresh tokens stay here."""

from __future__ import annotations

from base64 import urlsafe_b64encode
from binascii import Error as Base64Error
import hashlib
import hmac
from functools import lru_cache
import json
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Literal

import httpx
import jwt
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import load_pem_private_key

ISSUER = "https://appleid.apple.com"
JWKS_URL = ISSUER + "/auth/keys"
TOKEN_URL = ISSUER + "/auth/token"
REVOKE_URL = ISSUER + "/auth/revoke"
ORIGINAL_CLIENT_ID = "com.ordashtech.nuri.nativelab"
IOS_CLIENT_IDS = frozenset({
    ORIGINAL_CLIENT_ID, "com.ordashtech.nuri.beta", "com.ordashtech.nuri.earlyaccess",
})
CHALLENGE_TTL = 300
_NONCE = re.compile(r"^[0-9a-f]{64}$")
ApplePurpose = Literal["signin", "link", "delete"]
ACCOUNT_FIELDS = "apple_subject,apple_client_id,apple_refresh_ciphertext"
SESSION_FIELDS = "apple_session_generation,apple_authorized_at,apple_revoked_at,apple_relay_disabled"
EVENT_MAX_AGE = 7 * 24 * 60 * 60


class AppleAuthError(ValueError):
    """A stable safe code, never Apple's body or an SDK exception message."""


class AppleChallengeRateLimited(RuntimeError):
    pass


@dataclass(frozen=True)
class AppleConfiguration:
    team_id: str
    key_id: str
    private_key: str = field(repr=False)
    token_encryption_key: bytes = field(repr=False)
    client_id: str = ORIGINAL_CLIENT_ID

    def validate(self) -> None:
        if self.client_id not in IOS_CLIENT_IDS:
            raise AppleAuthError("APPLE_CONFIGURATION_INVALID")
        if not re.fullmatch(r"[A-Z0-9]{10}", self.team_id) or not re.fullmatch(r"[A-Z0-9]{10}", self.key_id):
            raise AppleAuthError("APPLE_CONFIGURATION_INVALID")
        try:
            key = load_pem_private_key(self.private_key.encode(), password=None)
            if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
                raise ValueError("wrong curve")
            Fernet(self.token_encryption_key)
        except (ValueError, TypeError, Base64Error) as exc:
            raise AppleAuthError("APPLE_CONFIGURATION_INVALID") from exc


def _nonce_digest(nonce: str) -> str:
    if not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", nonce):
        raise AppleAuthError("APPLE_CHALLENGE_INVALID")
    return hashlib.sha256(nonce.encode()).hexdigest()


def verify_identity_token(token: str, *, nonce: str, client_id: str,
                          signing_key: Callable[[str], object], require_nonce: bool = True) -> dict:
    if client_id not in IOS_CLIENT_IDS or not _NONCE.fullmatch(nonce):
        raise AppleAuthError("APPLE_TOKEN_INVALID")
    if not isinstance(token, str) or not 20 <= len(token) <= 16000 or token.count(".") != 2:
        raise AppleAuthError("APPLE_TOKEN_INVALID")
    try:
        header = jwt.get_unverified_header(token)
        # Apple's live public JWKS currently publishes RSA/RS256 signing keys.
        # Client-secret JWTs below are ES256; those are a different trust role.
        # Never accept a token-supplied jku/x5u or an algorithm chosen by it.
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str) or not header["kid"]:
            raise AppleAuthError("APPLE_TOKEN_INVALID")
        required = ["iss", "aud", "exp", "iat", "sub"]
        if require_nonce:
            required.append("nonce")
        claims = jwt.decode(token, signing_key(token), algorithms=["RS256"],
                            issuer=ISSUER, audience=client_id, leeway=30,
                            options={"require": required,
                                     "strict_aud": True})
        sub = claims.get("sub")
        actual_nonce = claims.get("nonce")
        if not isinstance(sub, str) or not 1 <= len(sub) <= 255:
            raise AppleAuthError("APPLE_TOKEN_INVALID")
        if (require_nonce or actual_nonce is not None) and (
            not isinstance(actual_nonce, str) or not hmac.compare_digest(nonce, actual_nonce)
        ):
            raise AppleAuthError("APPLE_TOKEN_INVALID")
        if not isinstance(claims["iat"], int) or isinstance(claims["iat"], bool):
            raise AppleAuthError("APPLE_TOKEN_INVALID")
        return claims
    except AppleAuthError:
        raise
    except jwt.PyJWKClientConnectionError as exc:
        raise AppleAuthError("APPLE_PROVIDER_UNAVAILABLE") from exc
    except (jwt.PyJWTError, ValueError, TypeError) as exc:
        raise AppleAuthError("APPLE_TOKEN_INVALID") from exc


def verified_email(claims: dict) -> str | None:
    # Email is optional on repeat authorizations and is NOT an account key.
    email = claims.get("email")
    if claims.get("email_verified") not in (True, "true") or not isinstance(email, str):
        return None
    value = email.strip().lower()
    return value if 3 <= len(value) <= 254 and value.count("@") == 1 else None


class AppleProvider:
    def __init__(self, config: AppleConfiguration, *, client: httpx.Client | None = None,
                 signing_key: Callable[[str], object] | None = None):
        config.validate()
        self.config = config
        self.client = client or httpx.Client(timeout=15, follow_redirects=False)
        self.cipher = Fernet(config.token_encryption_key)
        jwks = jwt.PyJWKClient(JWKS_URL, cache_keys=True, lifespan=3600, timeout=10)
        self.signing_key = signing_key or (lambda token: jwks.get_signing_key_from_jwt(token).key)

    def client_secret(self) -> str:
        now = int(time.time())
        # Short-lived; not a copied static secret or an ASC upload API key.
        return jwt.encode({"iss": self.config.team_id, "iat": now, "exp": now + 300,
                           "aud": ISSUER, "sub": self.config.client_id}, self.config.private_key,
                          algorithm="ES256", headers={"kid": self.config.key_id})

    def _post(self, endpoint: str, data: dict) -> httpx.Response:
        try:
            return self.client.post(endpoint, data={"client_id": self.config.client_id,
                                                   "client_secret": self.client_secret(), **data})
        except httpx.HTTPError as exc:
            raise AppleAuthError("APPLE_PROVIDER_UNAVAILABLE") from exc

    def exchange(self, *, code: str, identity_token: str, nonce: str) -> dict:
        claims = verify_identity_token(identity_token, nonce=nonce, client_id=self.config.client_id,
                                       signing_key=self.signing_key)
        if not isinstance(code, str) or not 1 <= len(code) <= 4096:
            raise AppleAuthError("APPLE_CODE_INVALID")
        if "c_hash" in claims:
            code_hash = urlsafe_b64encode(hashlib.sha256(code.encode()).digest()[:16]).rstrip(b"=").decode()
            if not isinstance(claims["c_hash"], str) or not hmac.compare_digest(code_hash, claims["c_hash"]):
                raise AppleAuthError("APPLE_CODE_INVALID")
        response = self._post(TOKEN_URL, {"grant_type": "authorization_code", "code": code})
        if response.status_code != 200:
            try:
                failed = response.json()
            except ValueError:
                failed = None
            if response.status_code == 400 and isinstance(failed, dict) and failed.get("error") == "invalid_grant":
                raise AppleAuthError("APPLE_CODE_INVALID")
            raise AppleAuthError("APPLE_PROVIDER_UNAVAILABLE")
        try:
            result = response.json()
            # A code is tied to the original nonce by its signed c_hash, or
            # by the nonce repeated by Apple's token endpoint. Require one.
            returned = verify_identity_token(result["id_token"], nonce=nonce, client_id=self.config.client_id,
                                             signing_key=self.signing_key, require_nonce="c_hash" not in claims)
            refresh = result["refresh_token"]
            if returned["sub"] != claims["sub"] or not isinstance(refresh, str) or not 1 <= len(refresh) <= 8000:
                raise AppleAuthError("APPLE_TOKEN_INVALID")
        except AppleAuthError:
            raise
        except (KeyError, ValueError, TypeError) as exc:
            raise AppleAuthError("APPLE_TOKEN_INVALID") from exc
        # Persist only this encrypted refresh grant in server-private storage.
        # No provider tokens or client secrets are part of the app response.
        return {"subject": claims["sub"], "verified_email": verified_email(returned) or verified_email(claims),
                "authorized_at": (
                    (claims["auth_time"] if type(claims.get("auth_time")) is int and
                     0 < claims["auth_time"] <= claims["iat"] else claims["iat"]) * 1000
                ),
                "encrypted_refresh_token": self.cipher.encrypt(refresh.encode()).decode()}

    def revoke(self, encrypted_refresh_token: str) -> None:
        try:
            refresh = self.cipher.decrypt(encrypted_refresh_token.encode()).decode()
        except (InvalidToken, ValueError, UnicodeError, AttributeError) as exc:
            raise AppleAuthError("APPLE_GRANT_UNAVAILABLE") from exc
        response = self._post(REVOKE_URL, {"token": refresh, "token_type_hint": "refresh_token"})
        if response.status_code != 200:
            raise AppleAuthError("APPLE_REVOCATION_UNCONFIRMED")


@lru_cache(maxsize=2)
def _provider(config: AppleConfiguration) -> AppleProvider:
    return AppleProvider(config)


def configured_provider() -> AppleProvider:
    """Read exact single-audience configuration from this backend environment."""
    return _provider(AppleConfiguration(
        team_id=os.getenv("APPLE_SIGNIN_TEAM_ID", "").strip(),
        key_id=os.getenv("APPLE_SIGNIN_KEY_ID", "").strip(),
        private_key=os.getenv("APPLE_SIGNIN_PRIVATE_KEY", "").strip().replace("\\n", "\n"),
        token_encryption_key=os.getenv("APPLE_SIGNIN_TOKEN_ENCRYPTION_KEY", "").strip().encode(),
        client_id=os.getenv("APPLE_SIGNIN_CLIENT_ID", "").strip(),
    ))


def enabled() -> bool:
    if os.getenv("APPLE_SIGNIN_ENABLED") != "1":
        return False
    try:
        configured_provider()
    except AppleAuthError:
        return False
    return True


def issue_nonce(sb, audience: str, purpose: ApplePurpose, owner: str | None, rate_identity: str) -> str:
    """Persist a one-use hash and debit the shared issuance window atomically."""
    nonce = secrets.token_urlsafe(32)
    key = configured_provider().config.token_encryption_key
    bucket = hmac.new(key, f"nuri.apple.rate.v1:{audience}:{rate_identity}".encode(), hashlib.sha256).hexdigest()
    issued = sb.rpc("issue_apple_signin_challenge", {
        "p_nonce_hash": _nonce_digest(nonce), "p_audience": audience,
        "p_purpose": purpose, "p_user_id": owner, "p_bucket": bucket,
    }).execute().data
    if issued is False:
        raise AppleChallengeRateLimited
    if issued is not True:
        raise RuntimeError("Apple challenge issuance was not confirmed")
    return nonce


def consume_nonce(sb, nonce: str, audience: str, purpose: ApplePurpose, owner: str | None) -> str:
    digest = _nonce_digest(nonce)
    query = (
        sb.table("apple_signin_challenges").delete().eq("nonce_hash", digest)
        .eq("audience", audience).eq("purpose", purpose)
        .gt("expires_at", datetime.now(timezone.utc).isoformat())
    )
    query = query.eq("user_id", owner) if owner is not None else query.is_("user_id", "null")
    rows = query.execute().data
    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("nonce_hash") != digest:
        raise AppleAuthError("APPLE_CHALLENGE_INVALID")
    return digest


def credentials(provider: AppleProvider, grant: dict) -> dict:
    return {
        "apple_subject": grant["subject"], "apple_client_id": provider.config.client_id,
        "apple_refresh_ciphertext": grant["encrypted_refresh_token"],
    }


@dataclass(frozen=True, repr=False)
class AppleLifecycleEvent:
    audience: str
    subject: str
    kind: str
    event_time: int
    receipt: str
    relay_email: str | None = None

    def record(self, sb) -> None:
        sb.rpc("record_apple_signin_event", {
            "p_receipt_hash": self.receipt, "p_audience": self.audience,
            "p_subject": self.subject, "p_event": self.kind,
            "p_event_time": self.event_time, "p_relay_email": self.relay_email,
        }).execute()


def verify_notification(token: str, audience: str, signing_key: Callable[[str], object]) -> AppleLifecycleEvent:
    """Validate an Apple event JWT independently from the login-token format."""
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str) or not header["kid"]:
            raise AppleAuthError("APPLE_NOTIFICATION_INVALID")
        claims = jwt.decode(token, signing_key(token), algorithms=["RS256"], issuer=ISSUER,
                            audience=audience, leeway=30,
                            options={"require": ["iss", "aud", "iat", "jti", "events"], "strict_aud": True})
        issued = claims["iat"]
        jti = claims["jti"]
        now = int(time.time())
        if type(issued) is not int or not now - EVENT_MAX_AGE <= issued <= now + 30:
            raise AppleAuthError("APPLE_NOTIFICATION_INVALID")
        if not isinstance(jti, str) or not 1 <= len(jti) <= 255:
            raise AppleAuthError("APPLE_NOTIFICATION_INVALID")
        event = claims["events"]
        if isinstance(event, str):
            event = json.loads(event)
        if not isinstance(event, dict):
            raise AppleAuthError("APPLE_NOTIFICATION_INVALID")
        kind, subject, stamp = event.get("type"), event.get("sub"), event.get("event_time")
        # Apple's guide uses seconds and 'account-deleted'. The WWDC session
        # names 'account-delete'; delivered events also use milliseconds.
        if kind == "account-delete":
            kind = "account-deleted"
        if kind not in {"email-enabled", "email-disabled", "consent-revoked", "account-deleted"}:
            raise AppleAuthError("APPLE_NOTIFICATION_INVALID")
        if not isinstance(subject, str) or not 1 <= len(subject) <= 255 or type(stamp) is not int:
            raise AppleAuthError("APPLE_NOTIFICATION_INVALID")
        if stamp < 100_000_000_000:
            stamp *= 1000
        if not (issued - EVENT_MAX_AGE) * 1000 <= stamp <= (issued + 30) * 1000:
            raise AppleAuthError("APPLE_NOTIFICATION_INVALID")
        email = None
        if kind in {"email-enabled", "email-disabled"}:
            relay = event.get("email")
            if (event.get("is_private_email") not in (True, "true") or not isinstance(relay, str)
                    or len(relay) > 254 or not relay.casefold().endswith("@privaterelay.appleid.com")):
                raise AppleAuthError("APPLE_NOTIFICATION_INVALID")
            email = relay.strip().lower()
        receipt = hashlib.sha256(json.dumps([audience, jti], separators=(",", ":")).encode()).hexdigest()
        return AppleLifecycleEvent(audience, subject, kind, stamp, receipt, email)
    except jwt.PyJWKClientConnectionError as exc:
        raise AppleAuthError("APPLE_PROVIDER_UNAVAILABLE") from exc
    except AppleAuthError:
        raise
    except (jwt.PyJWTError, ValueError, TypeError, KeyError) as exc:
        raise AppleAuthError("APPLE_NOTIFICATION_INVALID") from exc


def revoke_account(user: dict) -> bool:
    """True means local deletion can continue but Apple needs manual revocation."""
    if not user.get("apple_subject"):
        return False
    if user.get("apple_revoked_at") and not user.get("apple_refresh_ciphertext"):
        return False
    try:
        provider = configured_provider()
        if provider.config.client_id != user.get("apple_client_id"):
            raise AppleAuthError("APPLE_CONFIGURATION_INVALID")
        provider.revoke(user.get("apple_refresh_ciphertext"))
    except AppleAuthError:
        return True
    return False
