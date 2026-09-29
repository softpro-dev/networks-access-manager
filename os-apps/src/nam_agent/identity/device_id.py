"""Persistent device UUID: generated once (UUIDv4 from os.urandom), never regenerated."""

from __future__ import annotations

import re
import uuid

from ..storage.db import Database

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


class DeviceIdentityError(RuntimeError):
    pass


def get_or_create_device_uuid(db: Database) -> str:
    existing = db.get_device_uuid()
    if existing is not None:
        if not UUID_RE.match(existing):
            # Never silently replace an identity: an operator must investigate.
            raise DeviceIdentityError("stored device_uuid is corrupt; refusing to generate a new one")
        return existing
    # uuid4() draws 122 random bits from os.urandom (CSPRNG).
    return db.insert_device_uuid_if_absent(str(uuid.uuid4()))
