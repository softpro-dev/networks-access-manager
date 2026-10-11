import io

from nam_agent import cli
from nam_agent.config.paths import AgentPaths
from nam_agent.config.settings import write_env_file
from nam_agent.service import protection

# build.ps1 (PowerShell Rfc2898DeriveBytes) output for "142454"; keeps both sides in step.
PS_HASH = (
    "pbkdf2-sha256:200000:c0f01e8a706dd8d97ac931472a8f1666:"
    "603c76e877300ac37a82cc59c9c618a0e1b04024516bcc517afbc7bf05734e3b"
)


def _protect(tmp_path, password="142454"):
    paths = AgentPaths(tmp_path)
    paths.ensure()
    write_env_file(paths.env_file, {protection.HASH_KEY: protection.hash_password(password, iterations=1000)})
    return paths


def test_hash_roundtrip_and_powershell_format():
    encoded = protection.hash_password("142454", iterations=1000)
    assert protection.verify_password("142454", encoded)
    assert not protection.verify_password("142455", encoded)
    assert protection.verify_password("142454", PS_HASH)
    assert not protection.verify_password("x", PS_HASH)


def test_malformed_hash_never_verifies():
    for bad in ("", "pbkdf2-sha256:abc:00:00", "md5:1:00:00", "pbkdf2-sha256:0:00:00", "a:b"):
        assert not protection.verify_password("142454", bad)


def test_unprotected_without_hash(tmp_path):
    paths = AgentPaths(tmp_path)
    assert not protection.is_protected(paths)
    assert protection.check_password(paths, None)
    assert protection.consume_stop_permit(paths)


def test_stop_permit_is_one_time(tmp_path):
    paths = _protect(tmp_path)
    assert not protection.consume_stop_permit(paths)  # no permit
    protection.write_stop_permit(paths, "wrong")
    assert not protection.consume_stop_permit(paths)
    assert not protection.permit_path(paths).exists()
    protection.write_stop_permit(paths, "142454")
    assert protection.consume_stop_permit(paths)
    assert not protection.permit_path(paths).exists()
    assert not protection.consume_stop_permit(paths)  # already used


def _cli_env(tmp_path, monkeypatch, password=None):
    monkeypatch.setattr("nam_agent.security.elevation.is_elevated", lambda: True)
    monkeypatch.setenv("NAM_DATA_DIR", str(tmp_path))
    if password is None:
        monkeypatch.delenv(protection.PASSWORD_ENV, raising=False)
    else:
        monkeypatch.setenv(protection.PASSWORD_ENV, password)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))  # not a tty: never prompts


def test_check_password_cli(tmp_path, monkeypatch):
    _cli_env(tmp_path, monkeypatch, "")
    assert cli.main(["check-password"]) == 0  # nothing configured
    _protect(tmp_path)
    assert cli.main(["check-password"]) == cli.WRONG_PASSWORD_EXIT
    _cli_env(tmp_path, monkeypatch, "142454")
    assert cli.main(["check-password"]) == 0


class _Tty(io.StringIO):
    def isatty(self):
        return True


def test_hidden_runs_never_prompt(tmp_path, monkeypatch):
    # The uninstaller runs these in a hidden console and cannot set an empty variable:
    # a password prompt there waits forever and hangs the uninstall.
    _cli_env(tmp_path, monkeypatch)
    _protect(tmp_path)
    monkeypatch.setattr("sys.stdin", _Tty(""))

    def no_prompt(*_a, **_k):
        raise AssertionError("prompted")

    monkeypatch.setattr("getpass.getpass", no_prompt)
    svc = _fake_windows(monkeypatch)
    assert cli.main(["check-password"]) == cli.WRONG_PASSWORD_EXIT
    assert cli.main(["uninstall", "--no-prompt"]) == cli.WRONG_PASSWORD_EXIT
    assert svc.calls == []


def test_check_password_stdin(tmp_path, monkeypatch):
    _cli_env(tmp_path, monkeypatch)
    _protect(tmp_path)
    monkeypatch.setattr("sys.stdin", io.StringIO("142454\r\n"))
    assert cli.main(["check-password", "--password-stdin"]) == 0


class _FakeService:
    ServiceControlError = RuntimeError

    def __init__(self):
        self.calls = []

    def stop(self, password=None):
        self.calls.append(("stop", password))
        return "STOPPED"

    def stop_keep_restrictions(self):
        self.calls.append(("keep",))
        return "STOPPED"

    def uninstall(self, password=None):
        self.calls.append(("uninstall", password))


def _fake_windows(monkeypatch):
    svc = _FakeService()
    monkeypatch.setattr("nam_agent.cli.IS_WINDOWS", True)
    monkeypatch.setattr("nam_agent.cli.IS_MACOS", False)
    monkeypatch.setattr("nam_agent.cli._service_module", lambda: svc)
    monkeypatch.setattr("nam_agent.cli._remove_restrictions", lambda: svc.calls.append(("remove",)))
    return svc


def test_stop_and_uninstall_need_the_password(tmp_path, monkeypatch):
    _cli_env(tmp_path, monkeypatch, "nope")
    _protect(tmp_path)
    svc = _fake_windows(monkeypatch)
    assert cli.main(["stop"]) == cli.WRONG_PASSWORD_EXIT
    assert cli.main(["uninstall"]) == cli.WRONG_PASSWORD_EXIT
    assert svc.calls == []  # nothing touched, restrictions stay

    _cli_env(tmp_path, monkeypatch, "142454")
    assert cli.main(["stop"]) == 0
    assert cli.main(["uninstall"]) == 0
    assert svc.calls == [("stop", "142454"), ("uninstall", "142454"), ("remove",)]


def test_keep_restrictions_stop_needs_no_password(tmp_path, monkeypatch):
    _cli_env(tmp_path, monkeypatch)
    _protect(tmp_path)
    svc = _fake_windows(monkeypatch)
    assert cli.main(["stop", "--keep-restrictions"]) == 0
    assert svc.calls == [("keep",)]
