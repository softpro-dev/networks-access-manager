from fake_server import EXAMPLE_CONTENT

from nam_agent.policy.canonical import content_sha256
from nam_agent.security.protector import InsecureDevProtector
from nam_agent.security.secret_store import SecretStore
from nam_agent.storage.db import Database


def doc(version: int) -> dict:
    return {
        "schema_version": 1, "policy_id": "POL-001", "version": version, "organization_id": "INST-001",
        "device_uuid": "3f0c7a52-9a6e-4f5b-8a2c-2d9e1f4b7c10", "assignment_scope": "ORGANIZATION",
        "published_at": None, "content_sha256": content_sha256(EXAMPLE_CONTENT), "content": EXAMPLE_CONTENT,
    }


def test_wal_and_migrations(tmp_path):
    db = Database(tmp_path / "policy.db")
    assert db._conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert db.schema_version() == 1
    db.close()
    db = Database(tmp_path / "policy.db")  # re-running migrations is a no-op
    assert db.schema_version() == 1
    db.close()


def test_policy_cache_survives_reopen_and_rotates(tmp_path):
    db = Database(tmp_path / "policy.db")
    db.promote_candidate(doc(6), '"POL-001:6:0587ffd8"')
    db.store_candidate(doc(7), None)
    db.promote_candidate(doc(7), '"POL-001:7:0587ffd8"')
    db.update_row("sync_state", server_version=7)
    db.set_runtime("k", {"a": 1})
    db.close()

    db = Database(tmp_path / "policy.db")
    cur, prev = db.get_policy("current"), db.get_policy("previous")
    assert cur.pair == ("POL-001", 7) and cur.etag == '"POL-001:7:0587ffd8"'
    assert prev.pair == ("POL-001", 6)
    assert db.get_policy("candidate") is None
    assert cur.document["content"] == EXAMPLE_CONTENT
    assert db.get_row("sync_state")["server_version"] == 7
    assert db.get_runtime("k") == {"a": 1}
    db.close()


def test_secrets_are_stored_as_protected_blobs(tmp_path):
    db = Database(tmp_path / "policy.db")
    store = SecretStore(db, InsecureDevProtector())
    store.put("device_credential", "ndc_abc.def")
    protector, blob = db.get_secret("device_credential")
    assert protector == "insecure-dev" and blob.startswith(b"INSECURE-DEV:")
    assert store.get("device_credential") == "ndc_abc.def"
    assert store.delete("device_credential") and store.get("device_credential") is None
    db.close()
