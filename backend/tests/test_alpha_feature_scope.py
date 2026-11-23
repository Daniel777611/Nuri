from backend import runtime


def test_branch_fallback_requires_the_alpha_testing_database(monkeypatch):
    monkeypatch.delenv("VERCEL_GIT_COMMIT_REF", raising=False)
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setattr(runtime, "SUPABASE_URL", "https://kyxnnrmyzmdutqylsxpw.supabase.co")
    monkeypatch.setattr(runtime, "SUPABASE_SERVICE_ROLE_KEY", "testing-fixture")
    monkeypatch.delenv("NURI_ALPHA_FEATURES", raising=False)
    assert not runtime.alpha_features_available()
    monkeypatch.setenv("NURI_ALPHA_FEATURES", "1")
    assert runtime.alpha_features_available()
    monkeypatch.setattr(runtime, "SUPABASE_URL", "https://an-unrelated-project.supabase.co")
    assert not runtime.alpha_features_available()


def test_scope_is_explicit_when_preview_runtime_masks_git_environment(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.delenv("VERCEL_GIT_COMMIT_REF", raising=False)
    monkeypatch.delenv("NURI_ALPHA_FEATURES", raising=False)
    monkeypatch.setattr(runtime, "SUPABASE_URL", "https://kyxnnrmyzmdutqylsxpw.supabase.co")
    monkeypatch.setattr(runtime, "SUPABASE_SERVICE_ROLE_KEY", "testing-fixture")
    assert not runtime.alpha_features_available()
    monkeypatch.setenv("NURI_ALPHA_FEATURES", "1")
    assert runtime.alpha_features_available()
    monkeypatch.setattr(runtime, "SUPABASE_SERVICE_ROLE_KEY", "")
    assert not runtime.alpha_features_available()
