"""Service host: stopping the service on purpose lifts every restriction; shutdown keeps them."""

from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest

from nam_agent.service import host
from recording_backend import RecordingBackend


@pytest.fixture
def fake_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("NAM_DATA_DIR", str(tmp_path))
    backend = RecordingBackend()
    closed = []
    rt = SimpleNamespace(
        settings=SimpleNamespace(log_level="INFO", mode="org-token", organization_id=None, api_base_url="https://x/api"),
        agent=SimpleNamespace(run=lambda stop: None),  # returns as if `stop` had been set
        backend=backend,
        close=lambda: closed.append(True),
    )
    monkeypatch.setattr(host, "build_runtime", lambda paths: rt)
    return backend, closed


def stopped() -> threading.Event:
    e = threading.Event()
    e.set()
    return e


def test_admin_stop_removes_all_restrictions(fake_runtime):
    backend, closed = fake_runtime
    host.run_agent(threading.Event(), release_on_stop=lambda: True)
    assert ("remove",) in backend.calls
    assert closed == [True]


def test_windows_shutdown_keeps_restrictions(fake_runtime):
    backend, closed = fake_runtime
    host.run_agent(threading.Event(), release_on_stop=lambda: False)
    assert ("remove",) not in backend.calls
    assert closed == [True]


def test_foreground_run_never_removes(fake_runtime):
    backend, _ = fake_runtime
    host.run_agent(threading.Event())
    assert ("remove",) not in backend.calls


def test_failed_removal_does_not_block_stopping(fake_runtime):
    backend, closed = fake_runtime
    backend.fail_remove = True
    host.run_agent(threading.Event(), release_on_stop=lambda: True)
    assert closed == [True]
