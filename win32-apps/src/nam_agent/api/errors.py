"""Client-side error types. Messages never contain credentials."""

from __future__ import annotations


class ApiUnavailable(Exception):
    """Network error, timeout, TLS failure or 5xx: retry with backoff, keep cached policy."""

    def __init__(self, message: str, status: int | None = None, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class ApiError(Exception):
    """A 4xx response carrying the contract error envelope."""

    def __init__(self, status: int, code: str, message: str, retry_after: float | None = None):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after

    @property
    def is_auth_failure(self) -> bool:
        return self.status in (401, 403)

    @property
    def is_rate_limited(self) -> bool:
        return self.status == 429
