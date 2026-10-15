import pytest

from backend import account_deletion


@pytest.fixture(autouse=True)
def _signed_in_account_exists(request, monkeypatch):
    """Every authenticated request re-checks that its account still exists
    (account_deletion.load_account). Most suites fake a database without a
    users table, so their signed-in parent is taken to exist; the deletion
    suite exercises the real check."""
    if request.module.__name__.endswith("test_account_deletion"):
        return

    async def exists(_sb, uid, **_kwargs):
        return {"id": uid}

    monkeypatch.setattr(account_deletion, "load_account", exists)
