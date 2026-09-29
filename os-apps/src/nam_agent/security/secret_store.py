"""Named secrets persisted in SQLite as protector-encrypted blobs."""

from __future__ import annotations

from ..storage.db import Database
from .protector import SecretProtector, SecretProtectorError

REGISTRATION_TOKEN = "registration_token"
ENROLLMENT_SECRET = "enrollment_secret"
DEVICE_CREDENTIAL = "device_credential"


class SecretStore:
    def __init__(self, db: Database, protector: SecretProtector):
        self._db = db
        self._protector = protector

    def put(self, name: str, value: str) -> None:
        self._db.put_secret(name, self._protector.name, self._protector.protect(value.encode("utf-8")))

    def get(self, name: str) -> str | None:
        row = self._db.get_secret(name)
        if row is None:
            return None
        protector_name, blob = row
        if protector_name != self._protector.name:
            raise SecretProtectorError(
                f"secret {name!r} was stored with protector {protector_name!r}, current is {self._protector.name!r}"
            )
        return self._protector.unprotect(blob).decode("utf-8")

    def has(self, name: str) -> bool:
        return self._db.get_secret(name) is not None

    def delete(self, name: str) -> bool:
        return self._db.delete_secret(name)
