"""In-memory fake of server-network's agent API (docs/api-contract.md), served via httpx.MockTransport."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import secrets
from dataclasses import dataclass, field
from typing import Any

import httpx

from nam_agent.policy.canonical import content_sha256, make_etag

BASE_URL = "https://mgmt.example.test/api"
REG_TOKEN = "reg-token-0123456789"
ORG = "INST-001"
# Organization service access token (contract §4.2, org-token mode).
ACCESS_TOKEN = "nat_" + "a" * 43

EXAMPLE_CONTENT = {
    "enabled": True,
    "default_action": "allow",
    "allowed_domains": ["company.com", "*.company.com"],
    "blocked_domains": ["example.com", "*.example.com"],
    "blocked_ips": ["203.0.113.0/24", "2001:db8::/32"],
    "block_quic": True,
    "block_dot": True,
    "block_doh": True,
    "enforce_browser_policies": True,
}

HEARTBEAT_FIELDS = {"device_uuid", "agent_version", "current_policy_version", "current_ip", "status"}


def err(status: int, code: str, message: str = "error") -> httpx.Response:
    return httpx.Response(status, json={"error": {"code": code, "message": message}})


@dataclass
class Device:
    uuid: str
    org: str
    secret_hash: str | None
    status: str = "PENDING"
    token: str | None = None
    revoked: bool = False
    facts: dict = field(default_factory=dict)


@dataclass
class Assignment:
    policy_id: str
    version: int
    content: dict
    doc_overrides: dict = field(default_factory=dict)
    raw_body: bytes | None = None

    @property
    def sha(self) -> str:
        return content_sha256(self.content)

    @property
    def etag(self) -> str:
        return make_etag(self.policy_id, self.version, self.sha)


class FakeServer:
    def __init__(self) -> None:
        self.devices: dict[str, Device] = {}
        self.assignment: Assignment | None = None
        # Org-token mode (contract §4.2): merged organization-wide policy.
        self.org_assignment: Assignment | None = None
        self.access_token: str = ACCESS_TOKEN
        self.org_policy_downloads: list[dict] = []
        self.down = False
        self.fail_5xx = False
        self.health_ok = True
        self.heartbeat_interval = 60
        self.requests: list[httpx.Request] = []
        self.heartbeats: list[dict] = []
        self.status_reports: list[dict] = []
        self.acks: list[dict] = []
        self.policy_downloads: list[dict] = []
        self.transport = httpx.MockTransport(self.handle)

    # ------------------------------------------------------------ admin ops
    def approve(self, uuid: str) -> None:
        self.devices[uuid].status = "APPROVED"

    def reject(self, uuid: str) -> None:
        self.devices[uuid].status = "REJECTED"

    def revoke(self, uuid: str) -> None:
        self.devices[uuid].revoked = True

    def reenroll(self, uuid: str) -> None:
        d = self.devices[uuid]
        d.status, d.secret_hash, d.token, d.revoked = "PENDING", None, None, False

    def assign(self, policy_id: str, version: int, content: dict | None = None, **kw: Any) -> Assignment:
        self.assignment = Assignment(policy_id, version, copy.deepcopy(content or EXAMPLE_CONTENT), **kw)
        return self.assignment

    def assign_org(self, version: int = 1, content: dict | None = None, policy_id: str = "EFFECTIVE", **kw: Any) -> Assignment:
        self.org_assignment = Assignment(policy_id, version, copy.deepcopy(content or EXAMPLE_CONTENT), **kw)
        return self.org_assignment

    def org_document(self) -> dict:
        a = self.org_assignment
        assert a is not None
        doc = {
            "schema_version": 1,
            "policy_id": a.policy_id,
            "version": a.version,
            "organization_id": ORG,
            "assignment_scope": "ORGANIZATION",
            "published_at": "2026-09-29T12:00:00.000Z",
            "content_sha256": a.sha,
            "content": a.content,
        }
        doc.update(a.doc_overrides)
        return doc

    def device(self) -> Device:
        assert len(self.devices) == 1
        return next(iter(self.devices.values()))

    def document(self, dev: Device) -> dict:
        a = self.assignment
        assert a is not None
        doc = {
            "schema_version": 1,
            "policy_id": a.policy_id,
            "version": a.version,
            "organization_id": dev.org,
            "device_uuid": dev.uuid,
            "assignment_scope": "ORGANIZATION",
            "published_at": "2026-09-28T09:00:00.000Z",
            "content_sha256": a.sha,
            "content": a.content,
        }
        doc.update(a.doc_overrides)
        return doc

    def ref(self) -> dict | None:
        a = self.assignment
        return {"policy_id": a.policy_id, "version": a.version, "etag": a.etag} if a else None

    # -------------------------------------------------------------- routing
    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        if self.fail_5xx:
            return err(500, "INTERNAL_ERROR")
        path = request.url.path
        assert path.startswith("/api/"), path
        route = (request.method, path[len("/api") :])
        if route == ("GET", "/health"):
            return httpx.Response(200, json={"status": "ok" if self.health_ok else "down", "time": "now"})
        if route == ("POST", "/agent/register"):
            return self.register(request)
        if route == ("GET", "/agent/registration-status"):
            return self.registration_status(request)
        if route == ("GET", "/agent/org-policy"):
            return self.org_policy(request)
        dev_or_resp = self.authenticate(request)
        if isinstance(dev_or_resp, httpx.Response):
            return dev_or_resp
        dev = dev_or_resp
        if route == ("POST", "/agent/heartbeat"):
            body = json.loads(request.content)
            assert set(body) == HEARTBEAT_FIELDS, body
            if body["device_uuid"] != dev.uuid:
                return err(403, "DEVICE_MISMATCH")
            self.heartbeats.append(body)
            return httpx.Response(
                200, json={"server_time": "2026-09-28T10:00:00.000Z", "heartbeat_interval_seconds": self.heartbeat_interval, "policy": self.ref()}
            )
        if route == ("GET", "/agent/policy/version"):
            return httpx.Response(200, json=self.ref() or {"policy_id": None, "version": 0, "etag": None})
        if route == ("GET", "/agent/policy"):
            if self.assignment is None:
                return err(404, "NO_POLICY_ASSIGNED")
            a = self.assignment
            inm = request.headers.get("if-none-match")
            self.policy_downloads.append({"if_none_match": inm})
            if inm == a.etag:
                return httpx.Response(304, headers={"etag": a.etag})
            body = a.raw_body if a.raw_body is not None else json.dumps(self.document(dev)).encode()
            return httpx.Response(200, content=body, headers={"etag": a.etag, "content-type": "application/json"})
        if route == ("POST", "/agent/policy/status"):
            self.status_reports.append(json.loads(request.content))
            return httpx.Response(204)
        if route == ("POST", "/agent/policy/ack"):
            body = json.loads(request.content)
            a = self.assignment
            if not a or (body["policy_id"], body["version"], body["content_sha256"]) != (a.policy_id, a.version, a.sha):
                return err(409, "POLICY_MISMATCH")
            self.acks.append(body)
            return httpx.Response(204)
        return err(404, "NOT_FOUND")

    def org_policy(self, request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {self.access_token}":
            return err(401, "INVALID_ACCESS_TOKEN")
        if self.org_assignment is None:
            return err(404, "NO_POLICY_ASSIGNED")
        a = self.org_assignment
        inm = request.headers.get("if-none-match")
        self.org_policy_downloads.append({"if_none_match": inm, "device_mac": request.headers.get("x-device-mac")})
        if inm == a.etag:
            return httpx.Response(304, headers={"etag": a.etag})
        body = a.raw_body if a.raw_body is not None else json.dumps(self.org_document()).encode()
        return httpx.Response(200, content=body, headers={"etag": a.etag, "content-type": "application/json"})

    def register(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.headers.get("x-registration-token") != REG_TOKEN or body.get("organization_id") != ORG:
            return err(401, "INVALID_REGISTRATION_TOKEN")
        uuid = body["device_uuid"]
        existing = self.devices.get(uuid)
        if existing is None:
            self.devices[uuid] = Device(uuid, ORG, body["enrollment_secret_hash"], facts=body)
            return httpx.Response(201, json={"device_id": "dev_" + uuid[:8], "status": "PENDING"})
        if existing.secret_hash is None and existing.status == "PENDING":
            existing.secret_hash = body["enrollment_secret_hash"]
            return httpx.Response(200, json={"device_id": "dev_" + uuid[:8], "status": "PENDING"})
        if existing.secret_hash != body["enrollment_secret_hash"]:
            return err(409, "DEVICE_ALREADY_REGISTERED")
        existing.facts = body
        return httpx.Response(200, json={"device_id": "dev_" + uuid[:8], "status": existing.status})

    def registration_status(self, request: httpx.Request) -> httpx.Response:
        uuid = request.headers.get("x-device-uuid", "")
        raw = request.headers.get("x-enrollment-secret", "")
        dev = self.devices.get(uuid)
        if not dev or not dev.secret_hash or hashlib.sha256(raw.encode()).hexdigest() != dev.secret_hash:
            return err(401, "INVALID_ENROLLMENT")
        if dev.status != "APPROVED":
            return httpx.Response(200, json={"status": dev.status})
        dev.secret_hash = None  # consumed
        cred_id = "clx" + secrets.token_hex(8)
        secret = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
        dev.token = f"ndc_{cred_id}.{secret}"
        return httpx.Response(
            200,
            json={
                "status": "APPROVED",
                "credential": {"token": dev.token, "credential_id": cred_id, "issued_at": "2026-09-28T10:00:00.000Z", "expires_at": None},
            },
        )

    def authenticate(self, request: httpx.Request) -> Device | httpx.Response:
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            return err(401, "INVALID_CREDENTIAL")
        tok = auth[len("Bearer ") :]
        dev = next((d for d in self.devices.values() if d.token == tok), None)
        if dev is None:
            return err(401, "INVALID_CREDENTIAL")
        if dev.revoked:
            return err(403, "CREDENTIAL_REVOKED")
        if dev.status != "APPROVED":
            return err(403, "DEVICE_NOT_APPROVED")
        return dev
