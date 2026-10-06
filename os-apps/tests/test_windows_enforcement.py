"""Windows enforcement backend against an in-memory system (no real hosts/registry/firewall)."""

from __future__ import annotations

import pytest

from nam_agent.enforcement import EnforcementError, EnforcementState, ManagementEndpoints
from nam_agent.enforcement.windows import (
    CHROMIUM_KEYS,
    FIREFOX_KEY,
    HOSTS_BEGIN,
    WindowsEnforcementBackend,
    build_plan,
    render_hosts,
)
from nam_agent.policy.validator import EffectiveContent, ValidatedPolicy

MGMT = ManagementEndpoints(hosts=("admin.school.org",), addresses=("203.0.113.10",), port=443)
ORIGINAL_HOSTS = "# Copyright Microsoft\r\n127.0.0.1 localhost\r\n10.0.0.5 intranet.local\r\n"
CHROME = CHROMIUM_KEYS[0]


def policy(version=1, **content) -> ValidatedPolicy:
    c = dict(
        enabled=True,
        default_action="allow",
        allowed_domains=(),
        blocked_domains=(),
        blocked_ips=(),
        block_quic=True,
        block_dot=True,
        block_doh=True,
        enforce_browser_policies=True,
        redirect_rules=(),
    )
    c.update(content)
    return ValidatedPolicy("EFFECTIVE", version, "0" * 64, '"etag"', {}, EffectiveContent(**c))


class FakeOps:
    def __init__(self, hosts: str = ORIGINAL_HOSTS):
        self.hosts = hosts
        self.scalars: dict[str, dict] = {}
        self.lists: dict[str, tuple[str, ...]] = {}
        self.rules: tuple = ()
        self.flushed = 0
        self.policy_refreshes = 0
        self.fail_firewall = False

    def read_hosts(self):
        return self.hosts

    def write_hosts(self, text):
        self.hosts = text

    def reg_get_scalars(self, key, names):
        return {n: self.scalars[key][n] for n in names if n in self.scalars.get(key, {})}

    def reg_set_scalars(self, key, values):
        self.scalars.setdefault(key, {}).update(values)

    def reg_delete_values(self, key, names):
        for n in names:
            self.scalars.get(key, {}).pop(n, None)

    def reg_get_list(self, key):
        return self.lists.get(key)

    def reg_set_list(self, key, values):
        self.lists[key] = tuple(values)

    def reg_delete_key(self, key):
        self.lists.pop(key, None)

    def firewall_replace(self, rules):
        if self.fail_firewall:
            raise RuntimeError("netsh exploded")
        self.rules = tuple(rules)

    def firewall_rule_names(self):
        return tuple(sorted(r.name for r in self.rules))

    def flush_dns(self):
        self.flushed += 1

    def refresh_policies(self):
        self.policy_refreshes += 1

    def resolve(self, host):
        return {"learn.school.org": "198.51.100.7"}.get(host)


@pytest.fixture
def ops():
    return FakeOps()


@pytest.fixture
def backend(tmp_path, ops):
    return WindowsEnforcementBackend(tmp_path / "enforcement-state.json", ops=ops)


def test_blacklist_sinkholes_only_what_section5_blocks(backend, ops):
    backend.apply(policy(blocked_domains=("youtube.com", "*.games.com")), MGMT)
    entries = [line for line in ops.hosts.splitlines() if line.startswith("0.0.0.0")]
    # exact youtube.com does not cover www (§5); *.games.com covers subdomains but not the apex
    assert entries == ["0.0.0.0 youtube.com", "0.0.0.0 www.games.com", "0.0.0.0 m.games.com"]
    assert ops.hosts.startswith(ORIGINAL_HOSTS.rstrip("\r\n"))  # foreign lines untouched
    assert backend.verify().ok
    assert backend.status().state is EnforcementState.ACTIVE
    assert ops.flushed == 1


def test_wildcard_and_exact_together_block_everything(backend, ops):
    backend.apply(policy(blocked_domains=("youtube.com", "*.youtube.com")), MGMT)
    assert "0.0.0.0 www.youtube.com" in ops.hosts and "0.0.0.0 youtube.com" in ops.hosts
    assert set(ops.lists[CHROME + r"\URLBlocklist"]) == {"youtube.com", ".youtube.com"}


def test_management_host_is_never_blocked(backend, ops):
    backend.apply(policy(blocked_domains=("admin.school.org", "*.school.org"), blocked_ips=("203.0.113.0/24",)), MGMT)
    assert "admin.school.org" not in "".join(line for line in ops.hosts.splitlines() if line.startswith("0.0.0.0"))
    assert "admin.school.org" in ops.lists[CHROME + r"\URLAllowlist"]
    ip_rule = next(r for r in ops.rules if r.name.endswith("blocked IPs"))
    assert "203.0.113.10" not in ip_rule.remote_addresses  # carved out of the blocked /24
    assert "203.0.113.0/29" in ip_rule.remote_addresses


def test_allow_only_mode_uses_browser_allowlist_not_hosts(backend, ops):
    backend.apply(policy(default_action="block", allowed_domains=("school.org", "*.school.org")), MGMT)
    assert HOSTS_BEGIN not in ops.hosts  # an allowlist cannot be a hosts file
    assert ops.lists[CHROME + r"\URLBlocklist"] == ("*",)
    assert set(ops.lists[CHROME + r"\URLAllowlist"]) >= {".school.org", "school.org", "admin.school.org"}
    assert ops.lists[FIREFOX_KEY + r"\WebsiteFilter\Block"] == ("<all_urls>",)


def test_browser_flags_and_firewall_rules(backend, ops):
    backend.apply(policy(blocked_ips=("198.51.100.0/24",)), MGMT)
    for key in CHROMIUM_KEYS:
        assert ops.scalars[key] == {"DnsOverHttpsMode": "off", "QuicAllowed": 0}
    assert ops.scalars[FIREFOX_KEY + r"\DNSOverHTTPS"] == {"Enabled": 0, "Locked": 1}
    names = {r.name for r in ops.rules}
    assert {"SoftProIt Network - QUIC", "SoftProIt Network - DoT TCP", "SoftProIt Network - DoT UDP", "SoftProIt Network - blocked IPs"} == names


def test_redirect_points_source_at_target_address(backend, ops):
    backend.apply(policy(redirect_rules=(("games.com", "learn.school.org"),)), MGMT)
    assert "198.51.100.7 games.com" in ops.hosts
    assert ".learn.school.org" in ops.lists[CHROME + r"\URLAllowlist"]


def test_remove_restores_previous_registry_values_and_hosts(backend, ops):
    ops.scalars[CHROME] = {"QuicAllowed": 1}  # set by the organization's own GPO
    ops.lists[CHROME + r"\URLBlocklist"] = ("example.org",)
    backend.apply(policy(blocked_domains=("youtube.com",)), MGMT)
    assert ops.scalars[CHROME]["QuicAllowed"] == 0
    backend.remove()
    assert ops.scalars[CHROME] == {"QuicAllowed": 1}
    assert ops.lists[CHROME + r"\URLBlocklist"] == ("example.org",)
    assert CHROME + r"\URLAllowlist" not in ops.lists
    assert ops.hosts == ORIGINAL_HOSTS
    assert ops.rules == ()
    assert backend.status().state is EnforcementState.INACTIVE
    assert not backend.state_path.exists()


def test_new_policy_replaces_old_entries(backend, ops):
    backend.apply(policy(blocked_domains=("youtube.com",)), MGMT)
    backend.apply(policy(version=2, blocked_domains=("tiktok.com",), block_quic=False, block_dot=False), MGMT)
    assert "youtube.com" not in ops.hosts and "0.0.0.0 tiktok.com" in ops.hosts
    assert "QuicAllowed" not in ops.scalars[CHROME]
    assert ops.rules == ()
    assert backend.verify().ok


def test_browser_policies_skipped_when_disabled(backend, ops):
    backend.apply(policy(blocked_domains=("youtube.com",), enforce_browser_policies=False), MGMT)
    assert ops.lists == {} and all(not v for v in ops.scalars.values())
    assert "0.0.0.0 youtube.com" in ops.hosts


def test_failed_apply_leaves_clean_state(backend, ops):
    ops.fail_firewall = True
    with pytest.raises(EnforcementError):
        backend.apply(policy(blocked_domains=("youtube.com",)), MGMT)
    assert HOSTS_BEGIN not in ops.hosts
    assert backend.status().state is EnforcementState.INACTIVE


def test_verify_detects_tampering(backend, ops):
    backend.apply(policy(blocked_domains=("youtube.com",)), MGMT)
    ops.hosts = render_hosts(ops.hosts, ())  # someone deleted our block
    assert not backend.verify().ok


def test_plan_is_pure_and_deterministic():
    p = policy(blocked_domains=("youtube.com", "*.youtube.com"))
    assert build_plan(p, MGMT, lambda h: None) == build_plan(p, MGMT, lambda h: None)


def test_browsers_are_told_to_reload_after_apply_and_remove(backend, ops):
    """Without the policy-changed signal, open Chrome/Edge keep enforcing the old lists."""
    backend.apply(policy(default_action="block", allowed_domains=("youtube.com",)), MGMT)
    assert ops.policy_refreshes == 1
    backend.remove()
    assert ops.policy_refreshes == 2
    assert CHROME + r"\URLBlocklist" not in ops.lists


def test_failed_refresh_signal_does_not_fail_apply(backend, ops):
    def boom():
        raise OSError("RefreshPolicyEx unavailable")

    ops.refresh_policies = boom
    backend.apply(policy(blocked_domains=("youtube.com",)), MGMT)
    assert backend.verify().ok
