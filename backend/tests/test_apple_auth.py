"""Isolated provider-boundary tests: no real Apple, account, DB or secrets."""
import time
import socket

import httpx
import jwt
import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from backend import apple_auth as apple

RSA = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_RSA = rsa.generate_private_key(public_exponent=65537, key_size=2048)
EC = ec.generate_private_key(ec.SECP256R1())
PEM = EC.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                       serialization.NoEncryption()).decode()
NONCE = "a" * 64


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def denied(*_args, **_kwargs):
        pytest.fail("provider tests may not contact any real network or account")
    monkeypatch.setattr(socket, "getaddrinfo", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def token(key=RSA, **over):
    now = int(time.time())
    claims = {"iss": apple.ISSUER, "aud": apple.ORIGINAL_CLIENT_ID, "sub": "apple-subject",
              "nonce": NONCE, "iat": now, "exp": now + 300,
              "email": "parent@privaterelay.appleid.com", "email_verified": "true"}
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test-public-key"})


def config(**over):
    values = {"team_id": "TESTTEAM01", "key_id": "TESTKEY001", "private_key": PEM,
              "token_encryption_key": Fernet.generate_key()}
    values.update(over)
    return apple.AppleConfiguration(**values)


def verify(value):
    return apple.verify_identity_token(value, nonce=NONCE, client_id=apple.ORIGINAL_CLIENT_ID,
                                       signing_key=lambda _: RSA.public_key())


@pytest.mark.parametrize("over", [
    {"aud": "com.ordashtech.nuri.preview"}, {"aud": [apple.ORIGINAL_CLIENT_ID]},
    {"iss": "https://evil.example"}, {"exp": int(time.time()) - 600},
    {"iat": int(time.time()) + 600}, {"iat": True}, {"sub": ""}, {"sub": None},
    {"nonce": "b" * 64}, {"nonce": None}, {"exp": None},
])
def test_rejects_wrong_identity_claims(over):
    with pytest.raises(apple.AppleAuthError, match="APPLE_TOKEN_INVALID"):
        verify(token(**over))


def test_accepts_signed_nonce_bound_subject_but_does_not_require_repeat_email():
    claims = verify(token(email=None, email_verified=None))
    assert claims["sub"] == "apple-subject"
    assert apple.verified_email(claims) is None


def test_rejects_wrong_signature_and_algorithm_confusion():
    with pytest.raises(apple.AppleAuthError):
        verify(token(key=OTHER_RSA))
    forged = jwt.encode({"sub": "victim"}, "not-an-apple-key" * 4, algorithm="HS256", headers={"kid": "evil"})
    with pytest.raises(apple.AppleAuthError):
        verify(forged)


def test_email_is_verified_optional_metadata_never_the_subject():
    assert apple.verified_email({"email": " A@privaterelay.appleid.com ", "email_verified": True}) == "a@privaterelay.appleid.com"
    assert apple.verified_email({"email": "victim@example.com", "email_verified": False}) is None


def test_config_repr_does_not_expose_credentials():
    c = config()
    assert PEM not in repr(c) and c.token_encryption_key.decode() not in repr(c)


def test_code_exchange_validates_both_tokens_and_encrypts_refresh_grant():
    requests = []
    c = config()
    def handler(request):
        requests.append(request)
        assert request.url == apple.TOKEN_URL
        return httpx.Response(200, json={"id_token": token(), "refresh_token": "synthetic-grant"})
    provider = apple.AppleProvider(c, client=httpx.Client(transport=httpx.MockTransport(handler)),
                                    signing_key=lambda _: RSA.public_key())
    result = provider.exchange(code="synthetic-code", identity_token=token(), nonce=NONCE)
    assert result["subject"] == "apple-subject"
    assert "synthetic-grant" not in str(result)
    assert Fernet(c.token_encryption_key).decrypt(result["encrypted_refresh_token"].encode()) == b"synthetic-grant"
    from urllib.parse import parse_qs
    body = parse_qs(requests[0].content.decode())
    assert body["client_id"] == [apple.ORIGINAL_CLIENT_ID]
    assert "redirect_uri" not in body
    client_claims = jwt.decode(body["client_secret"][0], EC.public_key(), algorithms=["ES256"], audience=apple.ISSUER)
    assert client_claims["sub"] == apple.ORIGINAL_CLIENT_ID and client_claims["exp"] - client_claims["iat"] == 300


@pytest.mark.parametrize("response", [
    {"id_token": token(sub="another-user"), "refresh_token": "synthetic"},
    {"id_token": token(nonce="b" * 64), "refresh_token": "synthetic"},
    {"id_token": token(), "refresh_token": ""}, {},
])
def test_exchange_rejects_incomplete_or_mismatched_code_owner(response):
    provider = apple.AppleProvider(config(), client=httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json=response))), signing_key=lambda _: RSA.public_key())
    with pytest.raises(apple.AppleAuthError):
        provider.exchange(code="synthetic", identity_token=token(), nonce=NONCE)


@pytest.mark.parametrize("status", [200, 400, 500])
def test_revocation_requires_confirmed_apple_200_and_uses_refresh_not_identity_token(status):
    c = config()
    def handler(request):
        assert request.url == apple.REVOKE_URL
        assert b"token_type_hint=refresh_token" in request.content
        return httpx.Response(status, json={"error": "synthetic-private-error"})
    provider = apple.AppleProvider(c, client=httpx.Client(transport=httpx.MockTransport(handler)))
    encrypted = Fernet(c.token_encryption_key).encrypt(b"synthetic-refresh-grant").decode()
    if status == 200:
        assert provider.revoke(encrypted) is None
    else:
        with pytest.raises(apple.AppleAuthError, match="^APPLE_REVOCATION_UNCONFIRMED$"):
            provider.revoke(encrypted)


def test_invalid_ciphertext_or_config_fails_closed_without_network():
    def no_network(_):
        pytest.fail("no network allowed for invalid ciphertext")
    provider = apple.AppleProvider(config(), client=httpx.Client(transport=httpx.MockTransport(no_network)))
    with pytest.raises(apple.AppleAuthError, match="APPLE_GRANT_UNAVAILABLE"):
        provider.revoke("tampered")
    for c in (config(client_id="com.ordashtech.nuri.preview"), config(private_key="invalid"), config(token_encryption_key=b"invalid")):
        with pytest.raises(apple.AppleAuthError, match="APPLE_CONFIGURATION_INVALID"):
            c.validate()
