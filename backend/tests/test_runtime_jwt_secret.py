from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _import_runtime(*, vercel_env: str, jwt_secret: str | None) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT)
    env["VERCEL_ENV"] = vercel_env
    if jwt_secret is None:
        env.pop("JWT_SECRET", None)
    else:
        env["JWT_SECRET"] = jwt_secret
    return subprocess.run(
        [sys.executable, "-c", "import backend.runtime"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_production_rejects_missing_jwt_secret() -> None:
    result = _import_runtime(vercel_env="production", jwt_secret=None)
    assert result.returncode != 0
    assert "JWT_SECRET must be configured" in result.stderr


def test_preview_rejects_public_default_jwt_secret() -> None:
    result = _import_runtime(
        vercel_env="preview",
        jwt_secret="dev-secret-change-in-prod",
    )
    assert result.returncode != 0
    assert "JWT_SECRET must be configured" in result.stderr


def test_deployment_accepts_high_entropy_jwt_secret() -> None:
    result = _import_runtime(
        vercel_env="production",
        jwt_secret="a" * 64,
    )
    assert result.returncode == 0, result.stderr
