"""Windows enforcement backend: hosts-file sinkhole + browser enterprise policies + firewall rules.

Three layers, all installed and removed as one unit (contract: docs/windows-enforcement.md):

* **Browser policies** (HKLM\\SOFTWARE\\Policies): Chrome, Edge, Brave and Chromium get
  `URLBlocklist`/`URLAllowlist` (Allow Only mode = block `*` + allowlist), `DnsOverHttpsMode=off`
  (block_doh) and `QuicAllowed=0` (block_quic); Firefox gets `WebsiteFilter` and DoH off. A blocked
  page shows the browser's own "blocked by your organization" error in the same tab; browsers are
  never closed (Chromium reloads policies by itself, Firefox on its next start). Only written when
  `enforce_browser_policies` is true. Pre-existing values are backed up and restored by remove().
* **hosts file**: names the policy blocks (default allow mode) are sinkholed to 0.0.0.0 for every
  app, redirect sources point at the target's address. Lives between BEGIN/END markers.
* **Windows Firewall**: one rule group blocks `blocked_ips` (management addresses carved out),
  QUIC (UDP 443) and DNS-over-TLS (853).

The management server is always exempt (allowlisted, never sinkholed, never firewalled). Matching
follows contract §5 through `nam_agent.policy.domains.decide`. Nothing here inspects traffic or
records browsing. System access goes through `SystemOps` so the logic is testable off Windows;
Windows-only imports stay inside `WindowsSystemOps`.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import logging
import os
import socket
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

from ..policy.domains import decide, is_management_host
from ..policy.validator import ValidatedPolicy
from .base import (
    EnforcementBackend,
    EnforcementError,
    EnforcementState,
    EnforcementStatus,
    ManagementEndpoints,
    VerifyResult,
)

log = logging.getLogger(__name__)

HOSTS_BEGIN = "# BEGIN SoftProIt Network (managed by OrganizationNetworkAgent - do not edit)"
HOSTS_END = "# END SoftProIt Network"
SINKHOLE = "0.0.0.0"
FIREWALL_GROUP = "SoftProIt Network"
#: Subdomains also sinkholed when the policy blocks them (hosts files have no wildcards).
COMMON_SUBDOMAINS = ("www", "m")

CHROMIUM_KEYS = (
    r"SOFTWARE\Policies\Google\Chrome",
    r"SOFTWARE\Policies\Microsoft\Edge",
    r"SOFTWARE\Policies\BraveSoftware\Brave",
    r"SOFTWARE\Policies\Chromium",
)
FIREFOX_KEY = r"SOFTWARE\Policies\Mozilla\Firefox"

# Registry model: {key_path: {value_name: value}} for scalars; lists are subkeys with "1".."n".
RegScalars = dict[str, int | str]


# ---------------------------------------------------------------------------- plan (pure)


@dataclass(frozen=True)
class FirewallRule:
    name: str
    protocol: str  # "Any" | "TCP" | "UDP"
    remote_addresses: tuple[str, ...] = ()
    remote_port: str = ""


@dataclass(frozen=True)
class Plan:
    hosts_entries: tuple[tuple[str, str], ...]  # (address, name)
    #: key path -> scalar values we own under it
    reg_scalars: dict[str, RegScalars] = field(default_factory=dict)
    #: list subkey path -> ordered string values ("1".."n")
    reg_lists: dict[str, tuple[str, ...]] = field(default_factory=dict)
    firewall: tuple[FirewallRule, ...] = ()


def _base(pattern: str) -> str:
    return pattern[2:] if pattern.startswith("*.") else pattern


def chromium_filter(pattern: str) -> str:
    """Chromium URL filter for a §5 pattern: exact → '.host' (host only); '*.x' → 'x' (x and its
    subdomains; the apex is corrected with an exact allow entry when §5 allows it)."""
    return _base(pattern) if pattern.startswith("*.") else "." + pattern


def firefox_patterns(pattern: str) -> list[str]:
    host = _base(pattern)
    return [f"*://*.{host}/*"] if pattern.startswith("*.") else [f"*://{host}/*"]


def _decide(policy: ValidatedPolicy, name: str, mgmt: tuple[str, ...]) -> str:
    c = policy.content
    return decide(
        name,
        default_action=c.default_action,  # type: ignore[arg-type]
        allowed_domains=c.allowed_domains,
        blocked_domains=c.blocked_domains,
        redirect_rules=c.redirect_rules,
        enabled=c.enabled,
        management_hosts=mgmt,
    ).action


def _unique(items) -> tuple:
    return tuple(dict.fromkeys(items))


def build_plan(policy: ValidatedPolicy, management: ManagementEndpoints, resolve: Callable[[str], str | None]) -> Plan:
    c = policy.content
    mgmt = tuple(management.hosts)
    block_mode = c.default_action == "block"

    # hosts: only meaningful in allow mode (an allowlist cannot be expressed as a hosts file).
    hosts: list[tuple[str, str]] = []
    if not block_mode:
        candidates: list[str] = []
        for p in c.blocked_domains:
            base = _base(p)
            if not p.startswith("*."):
                candidates.append(p)
            candidates.extend(f"{s}.{base}" for s in COMMON_SUBDOMAINS)
        for name in _unique(candidates):
            if not is_management_host(name, mgmt) and _decide(policy, name, mgmt) == "block":
                hosts.append((SINKHOLE, name))
    for src, target in c.redirect_rules:
        names = [src] if not src.startswith("*.") else [f"{s}.{_base(src)}" for s in COMMON_SUBDOMAINS]
        addr = resolve(target)
        if not addr:
            log.warning("redirect target %s could not be resolved; redirect skipped", target)
            continue
        for name in names:
            if not is_management_host(name, mgmt) and _decide(policy, name, mgmt) == "redirect":
                hosts.append((addr, name))

    reg_scalars: dict[str, RegScalars] = {}
    reg_lists: dict[str, tuple[str, ...]] = {}
    if c.enforce_browser_policies:
        allow = [chromium_filter(p) for p in c.allowed_domains]
        allow += list(mgmt)  # management host and subdomains, always
        allow += ["." + t for _, t in c.redirect_rules]
        block = ["*"] if block_mode else []
        block += [chromium_filter(p) for p in c.blocked_domains]
        # '*.x' as a filter also covers x itself: put x back the way §5 decides it.
        for p in (*c.blocked_domains, *c.allowed_domains):
            if p.startswith("*."):
                apex = _base(p)
                (allow if _decide(policy, apex, mgmt) != "block" else block).append("." + apex)
        allow_t, block_t = _unique(allow), _unique(block)
        for key in CHROMIUM_KEYS:
            scalars: RegScalars = {}
            if c.block_doh:
                scalars["DnsOverHttpsMode"] = "off"
            if c.block_quic:
                scalars["QuicAllowed"] = 0
            reg_scalars[key] = scalars
            reg_lists[key + r"\URLBlocklist"] = block_t
            reg_lists[key + r"\URLAllowlist"] = allow_t
        ff_block = ["<all_urls>"] if block_mode else []
        ff_block += [x for p in c.blocked_domains for x in firefox_patterns(p)]
        ff_allow = [x for p in c.allowed_domains for x in firefox_patterns(p)]
        ff_allow += [x for h in mgmt for x in (f"*://{h}/*", f"*://*.{h}/*")]
        ff_allow += [f"*://{t}/*" for _, t in c.redirect_rules]
        reg_lists[FIREFOX_KEY + r"\WebsiteFilter\Block"] = _unique(ff_block)
        reg_lists[FIREFOX_KEY + r"\WebsiteFilter\Exceptions"] = _unique(ff_allow)
        if c.block_doh:
            reg_scalars[FIREFOX_KEY + r"\DNSOverHTTPS"] = {"Enabled": 0, "Locked": 1}

    rules: list[FirewallRule] = []
    blocked = _carve_out(c.blocked_ips, management.addresses)
    if blocked:
        rules.append(FirewallRule(f"{FIREWALL_GROUP} - blocked IPs", "Any", blocked))
    if c.block_quic:
        rules.append(FirewallRule(f"{FIREWALL_GROUP} - QUIC", "UDP", remote_port="443"))
    if c.block_dot:
        rules.append(FirewallRule(f"{FIREWALL_GROUP} - DoT TCP", "TCP", remote_port="853"))
        rules.append(FirewallRule(f"{FIREWALL_GROUP} - DoT UDP", "UDP", remote_port="853"))
    return Plan(tuple(hosts), reg_scalars, reg_lists, tuple(rules))


def _carve_out(blocked: tuple[str, ...], keep: tuple[str, ...]) -> tuple[str, ...]:
    """Block rules beat allow rules in Windows Firewall, so remove management addresses from
    every blocked range instead of adding an allow rule."""
    nets: list[ipaddress._BaseNetwork] = [ipaddress.ip_network(b, strict=False) for b in blocked]
    for k in keep:
        try:
            host = ipaddress.ip_network(k)
        except ValueError:
            continue
        out: list[ipaddress._BaseNetwork] = []
        for n in nets:
            if n.version == host.version and host.subnet_of(n):  # type: ignore[arg-type]
                out.extend(n.address_exclude(host) if n != host else [])  # type: ignore[arg-type]
            else:
                out.append(n)
        nets = out
    return tuple(str(n) if n.num_addresses > 1 else str(n.network_address) for n in nets)


def render_hosts(original: str, entries: tuple[tuple[str, str], ...]) -> str:
    """`original` with our marked block replaced by `entries` (or removed when empty)."""
    out: list[str] = []
    skipping = False
    for line in original.splitlines():
        if line.strip() == HOSTS_BEGIN:
            skipping = True
            continue
        if line.strip() == HOSTS_END and skipping:
            skipping = False
            continue
        if not skipping:
            out.append(line)
    while out and not out[-1].strip():
        out.pop()
    if entries:
        out += ["", HOSTS_BEGIN, *(f"{a} {n}" for a, n in entries), HOSTS_END]
    return "\r\n".join(out) + "\r\n"


def managed_hosts_entries(text: str) -> tuple[tuple[str, str], ...]:
    entries: list[tuple[str, str]] = []
    inside = False
    for line in text.splitlines():
        s = line.strip()
        if s == HOSTS_BEGIN:
            inside = True
        elif s == HOSTS_END:
            inside = False
        elif inside and s and not s.startswith("#"):
            parts = s.split()
            if len(parts) >= 2:
                entries.append((parts[0], parts[1]))
    return tuple(entries)


# ---------------------------------------------------------------------------- system access


class SystemOps(Protocol):
    def read_hosts(self) -> str: ...
    def write_hosts(self, text: str) -> None: ...
    def reg_get_scalars(self, key: str, names: list[str]) -> RegScalars: ...
    def reg_set_scalars(self, key: str, values: RegScalars) -> None: ...
    def reg_delete_values(self, key: str, names: list[str]) -> None: ...
    def reg_get_list(self, key: str) -> tuple[str, ...] | None: ...
    def reg_set_list(self, key: str, values: tuple[str, ...]) -> None: ...
    def reg_delete_key(self, key: str) -> None: ...
    def firewall_replace(self, rules: tuple[FirewallRule, ...]) -> None: ...
    def firewall_rule_names(self) -> tuple[str, ...]: ...
    def flush_dns(self) -> None: ...
    def resolve(self, host: str) -> str | None: ...


class WindowsSystemOps:  # pragma: no cover - exercised on Windows only
    """Real Windows implementation (runs as LocalSystem in the service)."""

    def __init__(self) -> None:
        root = os.environ.get("SystemRoot", r"C:\Windows")
        self.hosts_path = Path(root) / "System32" / "drivers" / "etc" / "hosts"

    # hosts — latin-1 round-trips every byte of lines we do not own.
    def read_hosts(self) -> str:
        try:
            return self.hosts_path.read_bytes().decode("latin-1")
        except FileNotFoundError:
            return ""

    def write_hosts(self, text: str) -> None:
        # Rewrite in place (keeps the file's ACL); the content is small.
        with open(self.hosts_path, "wb") as f:
            f.write(text.encode("latin-1", errors="replace"))
            f.flush()
            os.fsync(f.fileno())

    # registry (64-bit view, HKLM)
    def _open(self, key: str, write: bool):
        import winreg

        access = (winreg.KEY_ALL_ACCESS if write else winreg.KEY_READ) | winreg.KEY_WOW64_64KEY
        if write:
            return winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, key, 0, access)
        return winreg.OpenKeyEx(winreg.HKEY_LOCAL_MACHINE, key, 0, access)

    def reg_get_scalars(self, key: str, names: list[str]) -> RegScalars:
        import winreg

        out: RegScalars = {}
        try:
            with self._open(key, False) as k:
                for n in names:
                    try:
                        out[n] = winreg.QueryValueEx(k, n)[0]
                    except FileNotFoundError:
                        pass
        except FileNotFoundError:
            pass
        return out

    def reg_set_scalars(self, key: str, values: RegScalars) -> None:
        import winreg

        with self._open(key, True) as k:
            for n, v in values.items():
                winreg.SetValueEx(k, n, 0, winreg.REG_DWORD if isinstance(v, int) else winreg.REG_SZ, v)

    def reg_delete_values(self, key: str, names: list[str]) -> None:
        import winreg

        try:
            with self._open(key, True) as k:
                for n in names:
                    try:
                        winreg.DeleteValue(k, n)
                    except FileNotFoundError:
                        pass
        except FileNotFoundError:
            pass

    def reg_get_list(self, key: str) -> tuple[str, ...] | None:
        import winreg

        try:
            with self._open(key, False) as k:
                values: dict[int, str] = {}
                i = 0
                while True:
                    try:
                        n, v, _ = winreg.EnumValue(k, i)
                    except OSError:
                        break
                    if n.isdigit():
                        values[int(n)] = str(v)
                    i += 1
                return tuple(values[i] for i in sorted(values))
        except FileNotFoundError:
            return None

    def reg_set_list(self, key: str, values: tuple[str, ...]) -> None:
        import winreg

        self.reg_delete_key(key)
        with self._open(key, True) as k:
            for i, v in enumerate(values, start=1):
                winreg.SetValueEx(k, str(i), 0, winreg.REG_SZ, v)

    def reg_delete_key(self, key: str) -> None:
        import winreg

        try:
            winreg.DeleteKeyEx(winreg.HKEY_LOCAL_MACHINE, key, winreg.KEY_WOW64_64KEY, 0)
        except FileNotFoundError:
            pass

    # firewall (PowerShell NetSecurity module; values are validated IPs/ports, script is encoded)
    def _ps(self, script: str) -> str:
        # Real failures throw (-ErrorAction Stop → exit 1); a suppressed "nothing found" from
        # Get/Remove must not leave a failing $? as the exit code, hence the explicit exit 0.
        script = "$ProgressPreference='SilentlyContinue'\n" + script + "\nexit 0"
        encoded = base64.b64encode(script.encode("utf-16-le")).decode()
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            capture_output=True,
            text=True,
            timeout=120,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if r.returncode != 0:
            raise EnforcementError(f"firewall command failed: {r.stderr.strip()[:200]}")
        return r.stdout

    def firewall_replace(self, rules: tuple[FirewallRule, ...]) -> None:
        lines = [f"Remove-NetFirewallRule -Group '{FIREWALL_GROUP}' -ErrorAction SilentlyContinue"]
        for r in rules:
            args = [
                f"-DisplayName '{r.name}'",
                f"-Group '{FIREWALL_GROUP}'",
                "-Direction Outbound",
                "-Action Block",
                "-Profile Any",
                f"-Protocol {r.protocol}",
            ]
            if r.remote_addresses:
                args.append("-RemoteAddress " + ",".join(f"'{a}'" for a in r.remote_addresses))
            if r.remote_port:
                args.append(f"-RemotePort {r.remote_port}")
            lines.append("New-NetFirewallRule " + " ".join(args) + " -ErrorAction Stop | Out-Null")
        self._ps("$ErrorActionPreference='Stop'\n" + "\n".join(lines))

    def firewall_rule_names(self) -> tuple[str, ...]:
        out = self._ps(
            f"Get-NetFirewallRule -Group '{FIREWALL_GROUP}' -ErrorAction SilentlyContinue | ForEach-Object {{ $_.DisplayName }}"
        )
        return tuple(sorted(x.strip() for x in out.splitlines() if x.strip()))

    def flush_dns(self) -> None:
        subprocess.run(["ipconfig", "/flushdns"], capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)

    def resolve(self, host: str) -> str | None:
        try:
            return socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
        except OSError:
            return None


# ---------------------------------------------------------------------------- backend


class WindowsEnforcementBackend(EnforcementBackend):
    name = "windows"

    def __init__(self, state_path: Path, ops: SystemOps | None = None):
        self.state_path = state_path
        self.ops: SystemOps = ops or WindowsSystemOps()
        self._plan: Plan | None = None
        self._applied: tuple[str, int] | None = None

    # state file: registry values that existed before we first wrote them, restored by remove()
    def _load_state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            return {"scalars": {}, "lists": {}}

    def _save_state(self, state: dict) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
        os.replace(tmp, self.state_path)

    def _backup(self, plan: Plan) -> None:
        state = self._load_state()
        changed = False
        for key, values in plan.reg_scalars.items():
            known = state["scalars"].setdefault(key, {})
            missing = [n for n in values if n not in known]
            if missing:
                existing = self.ops.reg_get_scalars(key, missing)
                for n in missing:
                    known[n] = existing.get(n)  # None = did not exist
                changed = True
        for key in plan.reg_lists:
            if key not in state["lists"]:
                prev = self.ops.reg_get_list(key)
                state["lists"][key] = list(prev) if prev is not None else None
                changed = True
        if changed:
            self._save_state(state)

    def apply(self, policy: ValidatedPolicy, management: ManagementEndpoints) -> None:
        try:
            plan = build_plan(policy, management, self.ops.resolve)
            self._backup(plan)
            self._clear_registry_not_in(plan)
            for key, values in plan.reg_scalars.items():
                if values:
                    self.ops.reg_set_scalars(key, values)
            for key, values in plan.reg_lists.items():
                if values:
                    self.ops.reg_set_list(key, values)
                else:
                    self.ops.reg_delete_key(key)
            self.ops.write_hosts(render_hosts(self.ops.read_hosts(), plan.hosts_entries))
            self.ops.firewall_replace(plan.firewall)
            self.ops.flush_dns()
        except Exception as e:  # noqa: BLE001 - never leave a partial rule set
            log.error("enforcement apply failed: %s", e)
            try:
                self.remove()
            except Exception:  # noqa: BLE001
                log.exception("cleanup after a failed apply also failed")
            if isinstance(e, EnforcementError):
                raise
            raise EnforcementError(f"apply failed: {e.__class__.__name__}: {e}") from None
        self._plan = plan
        self._applied = policy.pair
        log.info(
            "enforcement applied: %d hosts entries, %d browser policy lists, %d firewall rules",
            len(plan.hosts_entries),
            sum(1 for v in plan.reg_lists.values() if v),
            len(plan.firewall),
        )

    def _clear_registry_not_in(self, plan: Plan) -> None:
        """Drop values we installed for an earlier policy that this one no longer sets."""
        state = self._load_state()
        for key, names in state["scalars"].items():
            gone = [n for n in names if n not in plan.reg_scalars.get(key, {})]
            if gone:
                self._restore_scalars(key, {n: names[n] for n in gone})
        for key, prev in state["lists"].items():
            if key not in plan.reg_lists:
                if prev:
                    self.ops.reg_set_list(key, tuple(prev))
                else:
                    self.ops.reg_delete_key(key)

    def _restore_scalars(self, key: str, backup: dict) -> None:
        delete = [n for n, v in backup.items() if v is None]
        restore = {n: v for n, v in backup.items() if v is not None}
        if delete:
            self.ops.reg_delete_values(key, delete)
        if restore:
            self.ops.reg_set_scalars(key, restore)

    def verify(self) -> VerifyResult:
        if self._plan is None:
            return VerifyResult(ok=False, detail="nothing applied")
        p = self._plan
        checks: list[str] = []
        if managed_hosts_entries(self.ops.read_hosts()) != p.hosts_entries:
            return VerifyResult(ok=False, detail="hosts file entries do not match")
        checks.append("hosts")
        for key, values in p.reg_lists.items():
            if (self.ops.reg_get_list(key) or ()) != values:
                return VerifyResult(ok=False, detail=f"browser policy mismatch: {key.rsplit(chr(92), 1)[-1]}")
        for key, values in p.reg_scalars.items():
            if values and self.ops.reg_get_scalars(key, list(values)) != values:
                return VerifyResult(ok=False, detail="browser policy value mismatch")
        checks.append("browser_policies")
        if self.ops.firewall_rule_names() != tuple(sorted(r.name for r in p.firewall)):
            return VerifyResult(ok=False, detail="firewall rules do not match")
        checks.append("firewall")
        return VerifyResult(ok=True, checks=tuple(checks))

    def remove(self) -> None:
        errors: list[str] = []

        def attempt(label: str, fn: Callable[[], None]) -> None:
            try:
                fn()
            except Exception as e:  # noqa: BLE001 - finish the rest, report at the end
                errors.append(f"{label}: {e}")

        attempt("hosts", lambda: self.ops.write_hosts(render_hosts(self.ops.read_hosts(), ())))
        attempt("firewall", lambda: self.ops.firewall_replace(()))
        state = self._load_state()
        for key, backup in state["scalars"].items():
            attempt("registry", lambda key=key, backup=backup: self._restore_scalars(key, backup))
        for key, prev in state["lists"].items():
            attempt(
                "registry",
                lambda key=key, prev=prev: self.ops.reg_set_list(key, tuple(prev)) if prev else self.ops.reg_delete_key(key),
            )
        attempt("dns", self.ops.flush_dns)
        if not errors:
            try:
                self.state_path.unlink()
            except FileNotFoundError:
                pass
        self._plan = None
        self._applied = None
        if errors:
            raise EnforcementError("remove incomplete: " + "; ".join(errors)[:300])

    def status(self) -> EnforcementStatus:
        if self._applied is None:
            return EnforcementStatus(EnforcementState.INACTIVE)
        return EnforcementStatus(EnforcementState.ACTIVE, policy_id=self._applied[0], version=self._applied[1])


def is_supported() -> bool:
    return sys.platform == "win32"
