import re

import pytest

from nam_agent.identity.device_id import DeviceIdentityError, get_or_create_device_uuid
from nam_agent.identity.system_info import format_windows_version
from nam_agent.storage.db import Database

V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def test_uuid_generated_once_and_persists_across_reopen(tmp_path):
    db = Database(tmp_path / "policy.db")
    first = get_or_create_device_uuid(db)
    assert V4.match(first)
    assert get_or_create_device_uuid(db) == first
    db.close()
    db2 = Database(tmp_path / "policy.db")
    assert get_or_create_device_uuid(db2) == first
    # insert path never overwrites
    assert db2.insert_device_uuid_if_absent("00000000-0000-4000-8000-000000000000") == first
    db2.close()


def test_agent_restart_keeps_uuid(harness):
    a = harness.start()
    u = a.device_uuid
    harness.start()
    assert harness.agent.device_uuid == u


def test_corrupt_uuid_is_not_silently_replaced(tmp_path):
    db = Database(tmp_path / "policy.db")
    db.insert_device_uuid_if_absent("not-a-uuid")
    with pytest.raises(DeviceIdentityError):
        get_or_create_device_uuid(db)
    db.close()


def test_windows_version_string():
    assert format_windows_version("Windows 10 Pro", "23H2", "22631", 4317) == "Windows 11 Pro 23H2 (10.0.22631.4317)"
    assert format_windows_version("Windows 10 Enterprise", "22H2", "19045", None) == "Windows 10 Enterprise 22H2 (10.0.19045)"
