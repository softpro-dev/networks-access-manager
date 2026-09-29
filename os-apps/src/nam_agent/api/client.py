"""HTTPS client for the agent endpoints (docs/api-contract.md).

* TLS verification on by default (VERIFY_TLS, optional CA_BUNDLE).
* Redirects are never followed, so credentials cannot be forwarded to another host.
* Secrets travel only in headers and never appear in exceptions or logs.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from pydantic import ValidationError

from .. import AGENT_VERSION
from .errors import ApiError, ApiUnavailable
from .models import HeartbeatResponse, PolicyFetch, PolicyRef, RegisterResponse, RegistrationStatus

log = logging.getLogger(__name__)

MAX_POLICY_BYTES = 4 * 1024 * 1024


def _retry_after(resp: httpx.Response) -> float | None:
    v = resp.headers.get("retry-after")
    try:
        return max(0.0, float(v)) if v else None
    except ValueError:
        return None


class AgentApiClient:
    def __init__(
        self,
        base_url: str,
        *,
        verify: bool | str = True,
        timeout: float = 15.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/") + "/",
            verify=verify,
            timeout=httpx.Timeout(timeout, connect=min(timeout, 10.0)),
            follow_redirects=False,
            transport=transport,
            headers={"User-Agent": f"OrganizationNetworkAgent/{AGENT_VERSION}", "Accept": "application/json"},
        )

    def close(self) -> None:
        self._client.close()

    # ------------------------------------------------------------ plumbing
    def _send(self, method: str, path: str, *, headers: dict[str, str] | None = None, json: Any = None) -> httpx.Response:
        try:
            resp = self._client.request(method, path.lstrip("/"), headers=headers, json=json)
        except httpx.TimeoutException:
            raise ApiUnavailable(f"{method} {path}: timeout") from None
        except httpx.TransportError as e:
            raise ApiUnavailable(f"{method} {path}: {e.__class__.__name__}") from None
        if resp.status_code >= 500:
            raise ApiUnavailable(f"{method} {path}: HTTP {resp.status_code}", resp.status_code, _retry_after(resp))
        if 300 <= resp.status_code < 400 and resp.status_code != 304:
            raise ApiUnavailable(f"{method} {path}: unexpected redirect (HTTP {resp.status_code})", resp.status_code)
        if resp.status_code >= 400:
            code, message = "HTTP_ERROR", f"HTTP {resp.status_code}"
            try:
                err = resp.json().get("error", {})
                code = str(err.get("code") or code)[:64]
                message = str(err.get("message") or message)[:300]
            except Exception:
                pass
            raise ApiError(resp.status_code, code, message, _retry_after(resp))
        return resp

    @staticmethod
    def _bearer(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    @staticmethod
    def _parse(model, resp: httpx.Response, what: str):
        try:
            return model.model_validate(resp.json())
        except (ValueError, ValidationError):
            raise ApiUnavailable(f"{what}: malformed response body", resp.status_code) from None

    # ----------------------------------------------------------- endpoints
    def health(self) -> dict[str, Any]:
        resp = self._send("GET", "health")
        try:
            body = resp.json()
        except ValueError:
            raise ApiUnavailable("health: malformed response body", resp.status_code) from None
        if not isinstance(body, dict) or body.get("status") != "ok":
            raise ApiUnavailable("health: server did not report status ok", resp.status_code)
        return body

    def register(self, registration_token: str, body: dict[str, Any]) -> RegisterResponse:
        resp = self._send("POST", "agent/register", headers={"X-Registration-Token": registration_token}, json=body)
        return self._parse(RegisterResponse, resp, "register")

    def registration_status(self, device_uuid: str, enrollment_secret: str) -> RegistrationStatus:
        resp = self._send(
            "GET",
            "agent/registration-status",
            headers={"X-Device-UUID": device_uuid, "X-Enrollment-Secret": enrollment_secret},
        )
        return self._parse(RegistrationStatus, resp, "registration-status")

    def heartbeat(self, token: str, body: dict[str, Any]) -> HeartbeatResponse:
        resp = self._send("POST", "agent/heartbeat", headers=self._bearer(token), json=body)
        return self._parse(HeartbeatResponse, resp, "heartbeat")

    def policy_version(self, token: str) -> PolicyRef:
        resp = self._send("GET", "agent/policy/version", headers=self._bearer(token))
        return self._parse(PolicyRef, resp, "policy/version")

    def get_policy(self, token: str, if_none_match: str | None = None) -> PolicyFetch:
        headers = self._bearer(token)
        if if_none_match:
            headers["If-None-Match"] = if_none_match
        try:
            resp = self._send("GET", "agent/policy", headers=headers)
        except ApiError as e:
            if e.status == 404 and e.code == "NO_POLICY_ASSIGNED":
                return PolicyFetch(kind="none")
            raise
        if resp.status_code == 304:
            return PolicyFetch(kind="not_modified", etag=resp.headers.get("etag"))
        if len(resp.content) > MAX_POLICY_BYTES:
            raise ApiUnavailable("policy: document too large", resp.status_code)
        return PolicyFetch(kind="document", body=resp.content, etag=resp.headers.get("etag"))

    def report_status(self, token: str, body: dict[str, Any]) -> None:
        self._send("POST", "agent/policy/status", headers=self._bearer(token), json=body)

    def ack(self, token: str, policy_id: str, version: int, sha256_hex: str) -> None:
        self._send(
            "POST",
            "agent/policy/ack",
            headers=self._bearer(token),
            json={"policy_id": policy_id, "version": version, "content_sha256": sha256_hex},
        )
