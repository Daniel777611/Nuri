"""Sign in with Google: which tokens are accepted, and what each does to accounts.

Tokens are signed here with a throwaway RSA key standing in for Google's, so
the real verification code runs; nothing reaches Google or a database.
"""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from backend import google_auth, main
from backend.tests.test_email_verification import _DB, _no_real_database, _register, env  # noqa: F401

CLIENT = "nuri-web.apps.googleusercontent.com"
_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(autouse=True)
def google(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_IDS", f"{CLIENT}, nuri-ios.apps.googleusercontent.com")
    monkeypatch.setattr(google_auth, "_signing_key", lambda _t: _KEY.public_key())


def _token(key=_KEY, **over):
    now = int(time.time())
    claims = {
        "iss": "https://accounts.google.com", "aud": CLIENT, "sub": "1098765",
        "email": "Mom@Gmail.com", "email_verified": True, "given_name": "Linda",
        "iat": now, "exp": now + 3600,
    }
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm="RS256")


def _google(env, token):
    return env.client.post("/api/auth/google", json={"credential": token})


@pytest.mark.parametrize("token", [
    _token(key=_OTHER_KEY),                                  # not Google's signature
    _token(aud="someone-else.apps.googleusercontent.com"),   # issued to another site
    _token(iss="https://evil.example.com"),
    _token(exp=int(time.time()) - 600, iat=int(time.time()) - 4000),
    _token(email_verified=False),
    _token(email=None),
])
def test_tokens_that_are_not_ours_or_not_verified_are_refused(env, token):
    res = _google(env, token)
    assert res.status_code == 401 and res.json()["detail"] == "GOOGLE_TOKEN_INVALID"
    assert not env.db.tables.get("users")


def test_a_new_google_account_is_created_verified_and_sent_to_onboarding(env):
    res = _google(env, _token())
    assert res.status_code == 200
    body = res.json()
    assert body["created"] is True and body["access_token"]
    user = body["user"]
    assert user["email"] == "mom@gmail.com" and user["email_verified"] is True
    assert user["nickname"] == "Linda" and user["onboarding_completed"] is False
    # Signing in again is the same account, not a second one.
    again = _google(env, _token()).json()
    assert again["created"] is False and again["user"]["id"] == user["id"]
    assert len(env.db.tables["users"]) == 1


def test_an_existing_verified_account_signs_in_with_google(env):
    env.db.tables["users"] = [{
        "id": "u1", "email": "mom@gmail.com", "email_verified_at": "2026-09-01T00:00:00+00:00",
        "nickname": "Momo", "city": "SF", "top_concerns": [], "hashed_password": main._hash_pw("secret12"),
        "onboarding_completed": True,
    }]
    body = _google(env, _token()).json()
    assert body["user"]["id"] == "u1" and body["user"]["nickname"] == "Momo"
    # Their email password still works.
    assert env.client.post("/api/auth/login", json={"email": "mom@gmail.com", "password": "secret12"}).status_code == 200


def test_an_unverified_squatter_loses_the_address_to_its_google_owner(env):
    _register(env, email="mom@gmail.com", password="squatter1")
    body = _google(env, _token()).json()
    assert body["user"]["email_verified"] is True
    # The password whoever parked the address chose no longer opens it.
    login = env.client.post("/api/auth/login", json={"email": "mom@gmail.com", "password": "squatter1"})
    assert login.status_code == 401


def test_without_a_client_id_google_sign_in_is_off(env, monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_IDS")
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    assert _google(env, _token()).json()["detail"] == "GOOGLE_SIGNIN_UNAVAILABLE"


def test_the_shells_client_ids_are_accepted_too(env):
    assert _google(env, _token(aud="nuri-ios.apps.googleusercontent.com")).status_code == 200
