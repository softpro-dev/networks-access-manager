"""Filesystem layout under the data root (C:\\ProgramData\\OrganizationNetworkAgent by default)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from ..platform import IS_WINDOWS

DATA_DIR_ENV = "NAM_DATA_DIR"
PRODUCT_DIR_NAME = "OrganizationNetworkAgent"


class DataDirError(RuntimeError):
    pass


@dataclass(frozen=True)
class AgentPaths:
    root: Path

    @property
    def config_dir(self) -> Path:
        return self.root / "config"

    @property
    def env_file(self) -> Path:
        return self.config_dir / "agent.env"

    @property
    def data_dir(self) -> Path:
        return self.root / "data"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "policy.db"

    @property
    def logs_dir(self) -> Path:
        return self.root / "logs"

    def ensure(self) -> None:
        for d in (self.config_dir, self.data_dir, self.logs_dir):
            d.mkdir(parents=True, exist_ok=True)


def default_root(environ: dict[str, str] | None = None) -> Path:
    """Resolve the data root.

    `NAM_DATA_DIR` always wins (development / tests). On Windows the default is
    `%ProgramData%\\OrganizationNetworkAgent`. Elsewhere there is no safe default,
    so NAM_DATA_DIR is required.
    """
    env = os.environ if environ is None else environ
    override = env.get(DATA_DIR_ENV)
    if override:
        return Path(override).expanduser().resolve()
    if IS_WINDOWS:
        program_data = env.get("ProgramData") or env.get("PROGRAMDATA") or r"C:\ProgramData"
        return Path(program_data) / PRODUCT_DIR_NAME
    raise DataDirError(f"{DATA_DIR_ENV} must be set when not running on Windows")


def resolve_paths(environ: dict[str, str] | None = None) -> AgentPaths:
    return AgentPaths(default_root(environ))
