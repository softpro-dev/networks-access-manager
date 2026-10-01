"""Admin desktop wrapper: server URL resolution (admin.env, unreadable agent.env)."""

from pathlib import Path

from nam_admin.config import resolve_admin_server


def _write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


def test_env_var_wins(tmp_path):
    admin_env = _write(tmp_path / "admin.env", 'ADMIN_SERVER="http://from-admin-env:3200"\n')
    assert resolve_admin_server(
        {"ADMIN_SERVER": "https://from-env"}, env_file=tmp_path / "none", admin_env_file=admin_env
    ) == "https://from-env"


def test_admin_env_beats_agent_env(tmp_path):
    admin_env = _write(tmp_path / "admin.env", 'ADMIN_SERVER="http://localhost:3200/"\n')
    agent_env = _write(tmp_path / "agent.env", 'ADMIN_SERVER="https://agent"\nACCESS_TOKE="nat_x"\n')
    assert resolve_admin_server({}, env_file=agent_env, admin_env_file=admin_env) == "http://localhost:3200"


def test_falls_back_to_agent_env(tmp_path):
    agent_env = _write(tmp_path / "agent.env", 'API_BASE_URL="https://mgmt.example.com/api"\n')
    assert resolve_admin_server(
        {}, env_file=agent_env, admin_env_file=tmp_path / "missing.env"
    ) == "https://mgmt.example.com"


def test_unreadable_agent_env_is_skipped(tmp_path, monkeypatch):
    """agent.env is SYSTEM/Administrators-only on Windows; a normal user gets
    PermissionError from stat(). That must not crash the app."""
    agent_env = _write(tmp_path / "agent.env", 'ADMIN_SERVER="https://agent"\n')
    real_is_file = Path.is_file

    def is_file(self):
        if self == agent_env:
            raise PermissionError(5, "Access is denied", str(self))
        return real_is_file(self)

    monkeypatch.setattr(Path, "is_file", is_file)
    assert resolve_admin_server({}, env_file=agent_env, admin_env_file=tmp_path / "missing.env") is None
    assert resolve_admin_server(
        {"API_BASE_URL": "https://env.example.com/api"}, env_file=agent_env, admin_env_file=None
    ) == "https://env.example.com"
