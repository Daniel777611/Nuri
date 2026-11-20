"""Mobile feature rollout and account compatibility using isolated data."""

import base64
from io import BytesIO
import json

from PIL import Image
from pydantic import ValidationError
import pytest

from backend import main
from backend.display_name import CHINESE_NAME_TOO_LONG, generated_display_name
from backend.release_features import mobile_updates_enabled
from backend.tests.test_community import env

EIGHT = "小小的阿谷和媽媽"
NINE = EIGHT + "𠮷"


def set_release(monkeypatch, branch, environment):
    if branch is None:
        monkeypatch.delenv("VERCEL_GIT_COMMIT_REF", raising=False)
    else:
        monkeypatch.setenv("VERCEL_GIT_COMMIT_REF", branch)
    if environment is None:
        monkeypatch.delenv("VERCEL_ENV", raising=False)
    else:
        monkeypatch.setenv("VERCEL_ENV", environment)


def image_payload():
    stream = BytesIO()
    Image.new("RGB", (2, 2), "purple").save(stream, format="PNG")
    return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode()


@pytest.mark.parametrize("branch,environment", [
    ("Testing-Backend-Alpha", "preview"),
    ("Testing-Backend-Beta", "preview"),
    ("main", "production"),
])
def test_released_mobile_channels_accept_ten_photos_and_reject_long_new_names(branch, environment, env, monkeypatch):
    set_release(monkeypatch, branch, environment)
    assert mobile_updates_enabled()
    photos = [image_payload()] * 10
    assert json.loads(main.UserMessageIn(image_base64=json.dumps(photos)).image_base64) == photos
    with pytest.raises(ValidationError):
        main.UserMessageIn(image_base64=json.dumps(photos + photos[:1]))
    response = env.client.post("/api/auth/register", json={
        "email": "fixture@example.com", "password": "fixture-password", "nickname": NINE,
    })
    assert response.status_code == 422
    assert response.json()["detail"] == CHINESE_NAME_TOO_LONG
    assert generated_display_name(NINE) == EIGHT
    assert generated_display_name("An English name") == "An English name"


@pytest.mark.parametrize("branch,environment", [
    (None, None), ("main", None), ("main", "preview"),
    ("unreleased-preview", "production"), ("Testing-Backend-Beta-copy", "preview"),
])
def test_unreleased_preview_channels_keep_single_photo_validation(branch, environment, monkeypatch):
    set_release(monkeypatch, branch, environment)
    assert not mobile_updates_enabled()
    photo = image_payload()
    assert main.UserMessageIn(image_base64=photo).image_base64 == photo
    with pytest.raises(ValidationError):
        main.UserMessageIn(image_base64=json.dumps([photo, photo]))
    assert generated_display_name(NINE) == NINE


@pytest.mark.parametrize("branch,environment", [
    ("Testing-Backend-Beta", "preview"), ("main", "production"),
])
def test_legacy_long_nickname_can_echo_with_another_field_and_existing_auth_is_preserved(branch, environment, env, monkeypatch):
    set_release(monkeypatch, branch, environment)
    user = next(row for row in env.db.rows("users") if row["id"] == "u_ann")
    user["nickname"] = NINE
    headers = {"Authorization": f"Bearer {main._make_token('u_ann')}"}
    response = env.client.put("/api/auth/me", headers=headers, json={"nickname": NINE, "city": "Taipei"})
    assert response.status_code == 200
    assert response.json()["nickname"] == NINE
    assert response.json()["city"] == "Taipei"
    response = env.client.put("/api/auth/me", headers=headers, json={"nickname": NINE + "人"})
    assert response.status_code == 422
    assert response.json()["detail"] == CHINESE_NAME_TOO_LONG
    response = env.client.put("/api/auth/me", json={"nickname": EIGHT})
    assert response.status_code == 401
    assert user["nickname"] == NINE
