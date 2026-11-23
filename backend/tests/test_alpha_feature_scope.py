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


def test_preview_feature_setting_cannot_enable_production(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv("VERCEL_GIT_COMMIT_REF", "Testing-Backend-Alpha")
    monkeypatch.setenv("NURI_ALPHA_FEATURES", "1")
    assert not runtime.alpha_features_available()
