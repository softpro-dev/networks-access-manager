import io

from fake_server import BASE_URL, REG_TOKEN

from nam_agent import cli
from nam_agent.config.paths import AgentPaths
from nam_agent.config.settings import read_env_file


def test_configure_token_stdin(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("NAM_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("NAM_SECRET_PROTECTOR", "insecure-dev")
    monkeypatch.setattr("nam_agent.config.configure.check_connectivity", lambda req, transport=None: None)
    monkeypatch.setattr("sys.stdin", io.StringIO(REG_TOKEN + "\n"))
    rc = cli.main(["configure", "--organization-id", "INST-001", "--server-url", BASE_URL, "--token-stdin"])
    assert rc == 0
    assert read_env_file(AgentPaths(tmp_path).env_file)["ORGANIZATION_ID"] == "INST-001"
    assert REG_TOKEN not in capsys.readouterr().out


def test_configure_invalid_org_exit_code(tmp_path, monkeypatch):
    monkeypatch.setenv("NAM_DATA_DIR", str(tmp_path))
    monkeypatch.setattr("sys.stdin", io.StringIO("tok\n"))
    assert cli.main(["configure", "--organization-id", "bad", "--server-url", BASE_URL, "--token-stdin"]) == 2


def test_service_commands_fail_cleanly_off_windows(monkeypatch):
    assert cli.main(["install"]) == 1
