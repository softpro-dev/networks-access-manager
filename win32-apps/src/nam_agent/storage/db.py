"""SQLite persistence (`<data root>\\data\\policy.db`).

WAL journal, `synchronous=FULL`, versioned migrations recorded in `schema_migrations`.
Singleton state tables use `id = 1`. Every write is its own transaction so a crash
never leaves a half-rotated policy.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

MIGRATIONS: list[tuple[int, str]] = [
    (
        1,
        """
        CREATE TABLE device_identity (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            device_uuid TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE device_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enrollment_state TEXT NOT NULL DEFAULT 'UNREGISTERED',
            device_id TEXT,
            organization_id TEXT,
            registered_at TEXT,
            approved_at TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE auth_metadata (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            credential_id TEXT,
            issued_at TEXT,
            expires_at TEXT,
            last_auth_ok_at TEXT,
            last_auth_error TEXT,
            last_auth_error_at TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE secrets (
            name TEXT PRIMARY KEY,
            protector TEXT NOT NULL,
            blob BLOB NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE policies (
            slot TEXT PRIMARY KEY CHECK (slot IN ('current', 'previous', 'candidate')),
            policy_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            content_sha256 TEXT NOT NULL,
            etag TEXT,
            document TEXT NOT NULL,
            stored_at TEXT NOT NULL,
            activated_at TEXT
        );
        CREATE TABLE policy_status (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            policy_id TEXT,
            version INTEGER,
            status TEXT,
            error_code TEXT,
            message TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE sync_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_heartbeat_at TEXT,
            last_heartbeat_ok_at TEXT,
            last_version_check_at TEXT,
            last_download_at TEXT,
            server_policy_id TEXT,
            server_version INTEGER,
            server_etag TEXT,
            heartbeat_interval INTEGER,
            failed_policy_id TEXT,
            failed_version INTEGER,
            failed_sha256 TEXT,
            failed_at TEXT,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE runtime_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """,
    ),
]

SINGLETON_TABLES = ("device_state", "auth_metadata", "policy_status", "sync_state")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class StoredPolicy:
    slot: str
    policy_id: str
    version: int
    content_sha256: str
    etag: str | None
    document: dict[str, Any]
    stored_at: str
    activated_at: str | None

    @property
    def pair(self) -> tuple[str, int]:
        return (self.policy_id, self.version)


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), isolation_level=None, check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._migrate()

    # ------------------------------------------------------------------ infra
    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            else:
                self._conn.execute("COMMIT")

    def _migrate(self) -> None:
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            applied = {r[0] for r in self._conn.execute("SELECT version FROM schema_migrations")}
            for version, sql in MIGRATIONS:
                if version in applied:
                    continue
                self._conn.execute("BEGIN IMMEDIATE")
                try:
                    for stmt in [s.strip() for s in sql.split(";") if s.strip()]:
                        self._conn.execute(stmt)
                    self._conn.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", (version, utcnow()))
                    self._conn.execute("COMMIT")
                except BaseException:
                    self._conn.execute("ROLLBACK")
                    raise
            now = utcnow()
            for table in SINGLETON_TABLES:
                self._conn.execute(f"INSERT OR IGNORE INTO {table} (id, updated_at) VALUES (1, ?)", (now,))

    def schema_version(self) -> int:
        row = self._conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
        return int(row[0] or 0)

    # --------------------------------------------------------------- identity
    def get_device_uuid(self) -> str | None:
        row = self._conn.execute("SELECT device_uuid FROM device_identity WHERE id = 1").fetchone()
        return row[0] if row else None

    def insert_device_uuid_if_absent(self, device_uuid: str) -> str:
        """Insert once; never overwrite. Returns the value that is stored."""
        with self.tx() as c:
            c.execute(
                "INSERT OR IGNORE INTO device_identity (id, device_uuid, created_at) VALUES (1, ?, ?)",
                (device_uuid, utcnow()),
            )
            return c.execute("SELECT device_uuid FROM device_identity WHERE id = 1").fetchone()[0]

    # -------------------------------------------------------- singleton rows
    def get_row(self, table: str) -> dict[str, Any]:
        assert table in SINGLETON_TABLES
        row = self._conn.execute(f"SELECT * FROM {table} WHERE id = 1").fetchone()
        return dict(row)

    def update_row(self, table: str, **fields: Any) -> None:
        assert table in SINGLETON_TABLES
        if not fields:
            return
        cols = list(fields)
        for col in cols:
            if not col.isidentifier():
                raise ValueError("bad column")
        sets = ", ".join(f"{c} = ?" for c in cols)
        with self.tx() as c:
            c.execute(f"UPDATE {table} SET {sets}, updated_at = ? WHERE id = 1", (*fields.values(), utcnow()))

    # ---------------------------------------------------------------- secrets
    def put_secret(self, name: str, protector: str, blob: bytes) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO secrets (name, protector, blob, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(name) DO UPDATE SET protector = excluded.protector, blob = excluded.blob, updated_at = excluded.updated_at",
                (name, protector, sqlite3.Binary(blob), utcnow()),
            )

    def get_secret(self, name: str) -> tuple[str, bytes] | None:
        row = self._conn.execute("SELECT protector, blob FROM secrets WHERE name = ?", (name,)).fetchone()
        return (row[0], bytes(row[1])) if row else None

    def delete_secret(self, name: str) -> bool:
        with self.tx() as c:
            return c.execute("DELETE FROM secrets WHERE name = ?", (name,)).rowcount > 0

    # --------------------------------------------------------------- policies
    def get_policy(self, slot: str) -> StoredPolicy | None:
        row = self._conn.execute("SELECT * FROM policies WHERE slot = ?", (slot,)).fetchone()
        if not row:
            return None
        return StoredPolicy(
            slot=row["slot"],
            policy_id=row["policy_id"],
            version=row["version"],
            content_sha256=row["content_sha256"],
            etag=row["etag"],
            document=json.loads(row["document"]),
            stored_at=row["stored_at"],
            activated_at=row["activated_at"],
        )

    @staticmethod
    def _put_policy(c: sqlite3.Connection, slot: str, document: dict[str, Any], etag: str | None, activated_at: str | None) -> None:
        c.execute(
            "INSERT OR REPLACE INTO policies (slot, policy_id, version, content_sha256, etag, document, stored_at, activated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                slot,
                document["policy_id"],
                int(document["version"]),
                document["content_sha256"],
                etag,
                json.dumps(document, sort_keys=True, ensure_ascii=False),
                utcnow(),
                activated_at,
            ),
        )

    def store_candidate(self, document: dict[str, Any], etag: str | None) -> None:
        with self.tx() as c:
            self._put_policy(c, "candidate", document, etag, None)

    def clear_candidate(self) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM policies WHERE slot = 'candidate'")

    def promote_candidate(self, document: dict[str, Any], etag: str | None) -> None:
        """Atomically: previous <- current, current <- candidate document, drop candidate slot."""
        with self.tx() as c:
            cur = c.execute("SELECT * FROM policies WHERE slot = 'current'").fetchone()
            if cur is not None:
                c.execute("DELETE FROM policies WHERE slot = 'previous'")
                c.execute("UPDATE policies SET slot = 'previous' WHERE slot = 'current'")
            self._put_policy(c, "current", document, etag, utcnow())
            c.execute("DELETE FROM policies WHERE slot = 'candidate'")

    # ---------------------------------------------------------- runtime state
    def set_runtime(self, key: str, value: Any) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)",
                (key, json.dumps(value), utcnow()),
            )

    def get_runtime(self, key: str, default: Any = None) -> Any:
        row = self._conn.execute("SELECT value FROM runtime_state WHERE key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else default
