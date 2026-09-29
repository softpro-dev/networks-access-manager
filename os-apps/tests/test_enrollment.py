import hashlib

from fake_server import BASE_URL, REG_TOKEN

from nam_agent.config.settings import read_env_file, write_env_file
from nam_agent.security.secret_store import DEVICE_CREDENTIAL, ENROLLMENT_SECRET, REGISTRATION_TOKEN


def test_register_pending_then_claim_credential_and_use_bearer(harness, server):
    a = harness.start()
    a.tick()
    dev = server.device()
    assert dev.status == "PENDING" and dev.facts["organization_id"] == "INST-001"
    reg = next(r for r in server.requests if r.url.path.endswith("/agent/register"))
    assert reg.headers["x-registration-token"] == REG_TOKEN
    body = dev.facts
    assert set(body) == {"organization_id", "device_uuid", "hostname", "windows_version", "agent_version", "enrollment_secret_hash", "interfaces"}
    primary = [i for i in body["interfaces"] if i["is_primary"]]
    assert [i["name"] for i in primary] == ["Ethernet"]

    secret = a.d.secrets.get(ENROLLMENT_SECRET)
    assert hashlib.sha256(secret.encode()).hexdigest() == dev.secret_hash
    assert len(secret) == 43  # 32 bytes base64url, unpadded

    # still pending: poll interval returned, no credential
    assert a.tick() == float(a.settings.enrollment_poll_interval)
    assert not a.enrollment.is_enrolled()

    server.approve(a.device_uuid)
    a.tick()
    assert a.enrollment.is_enrolled()
    assert a.d.secrets.get(DEVICE_CREDENTIAL) == dev.token
    # registration token and enrollment secret are gone
    assert not a.d.secrets.has(REGISTRATION_TOKEN)
    assert not a.d.secrets.has(ENROLLMENT_SECRET)
    assert a.enrollment.state == "ENROLLED"
    # subsequent calls authenticate with the bearer credential only
    hb = [r for r in server.requests if r.url.path.endswith("/agent/heartbeat")]
    assert hb and hb[-1].headers["authorization"] == f"Bearer {dev.token}"
    assert "x-registration-token" not in hb[-1].headers
    assert harness.db.get_row("auth_metadata")["credential_id"] == dev.token[4:].split(".")[0]


def test_credential_survives_restart_without_reregistering(harness, server):
    harness.enroll()
    n_reg = sum(r.url.path.endswith("/register") for r in server.requests)
    a = harness.start()
    a.tick()
    assert sum(r.url.path.endswith("/register") for r in server.requests) == n_reg
    assert server.heartbeats[-1]["device_uuid"] == a.device_uuid


def test_bad_registration_token(harness, server):
    harness.settings_overrides["device_registration_token"] = "wrong-token"
    a = harness.start()
    assert a.tick() == 300.0
    assert not server.devices
    assert harness.db.get_row("device_state")["last_error"] == "INVALID_REGISTRATION_TOKEN"


def test_no_token_needs_configuration(harness, server):
    harness.settings_overrides["device_registration_token"] = None
    a = harness.start()
    assert a.tick() == 300.0
    assert a.enrollment.state == "NEEDS_CONFIGURATION"
    assert not server.requests


def test_rejected_device_polls_slowly(harness, server):
    a = harness.start()
    a.tick()
    server.reject(a.device_uuid)
    assert a.tick() == 300.0
    assert a.enrollment.state == "REJECTED"


def test_conflict_then_admin_reenroll(harness, server):
    a = harness.start()
    a.tick()
    # lose local enrollment secret (e.g. restored disk image) -> new secret -> 409
    a.d.secrets.delete(ENROLLMENT_SECRET)
    assert a.tick() == 300.0
    assert harness.db.get_row("device_state")["last_error"] == "DEVICE_ALREADY_REGISTERED"
    server.reenroll(a.device_uuid)
    a.tick()  # new secret binds
    server.approve(a.device_uuid)
    a.tick()
    a.tick()
    assert a.enrollment.is_enrolled()


def test_token_from_agent_env_is_moved_into_protected_store(harness):
    write_env_file(harness.paths.env_file, {"ORGANIZATION_ID": "INST-001", "API_BASE_URL": BASE_URL, "DEVICE_REGISTRATION_TOKEN": REG_TOKEN})
    a = harness.start(token_source="file")
    assert "DEVICE_REGISTRATION_TOKEN" not in read_env_file(harness.paths.env_file)
    assert a.d.secrets.get(REGISTRATION_TOKEN) == REG_TOKEN


def test_revoked_credential_with_new_token_reenrolls(harness, server):
    a = harness.enroll()
    server.reenroll(a.device_uuid)  # server resets device; old token invalid
    a.d.secrets.put(REGISTRATION_TOKEN, REG_TOKEN)  # admin re-ran configure
    harness.clock.advance(61)
    a.tick()  # 401 -> drop credential
    assert not a.enrollment.is_enrolled()
    a.tick()  # register with new secret
    server.approve(a.device_uuid)
    a.tick()
    assert a.enrollment.is_enrolled()
