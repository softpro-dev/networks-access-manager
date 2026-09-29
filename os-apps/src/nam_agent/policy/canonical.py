"""Canonical JSON + SHA-256 (contract §4)."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def content_sha256(content: Any) -> str:
    return hashlib.sha256(canonical_json(content).encode("utf-8")).hexdigest()


def make_etag(policy_id: str, version: int, sha256_hex: str) -> str:
    return f'"{policy_id}:{version}:{sha256_hex[:8]}"'
