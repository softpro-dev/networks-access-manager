"""Secret protection at rest.

Production uses Windows DPAPI with machine scope (CRYPTPROTECT_LOCAL_MACHINE):
the blob can be decrypted only on this machine, and the ProgramData ACL
(SYSTEM + Administrators only) keeps standard users away from the blob itself.

`InsecureDevProtector` exists solely for development/tests on non-Windows
hosts. It performs NO encryption and must be selected explicitly with
NAM_SECRET_PROTECTOR=insecure-dev.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..platform import IS_WINDOWS

CRYPTPROTECT_UI_FORBIDDEN = 0x1
CRYPTPROTECT_LOCAL_MACHINE = 0x4
# Application-specific entropy: not a secret, just domain separation from other DPAPI users.
_DPAPI_ENTROPY = b"OrganizationNetworkAgent/secret-store/v1"


class SecretProtectorError(RuntimeError):
    pass


class SecretProtector(ABC):
    name: str

    @abstractmethod
    def protect(self, plaintext: bytes) -> bytes: ...

    @abstractmethod
    def unprotect(self, blob: bytes) -> bytes: ...


class DpapiMachineProtector(SecretProtector):
    name = "dpapi-machine"

    def __init__(self) -> None:
        if not IS_WINDOWS:
            raise SecretProtectorError("DPAPI is only available on Windows")
        try:
            import win32crypt  # noqa: F401  (pywin32, Windows only)
        except ImportError as e:  # pragma: no cover - Windows only
            raise SecretProtectorError("pywin32 (win32crypt) is not installed") from e

    def protect(self, plaintext: bytes) -> bytes:  # pragma: no cover - Windows only
        import win32crypt

        return win32crypt.CryptProtectData(
            plaintext,
            "OrganizationNetworkAgent",
            _DPAPI_ENTROPY,
            None,
            None,
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
        )

    def unprotect(self, blob: bytes) -> bytes:  # pragma: no cover - Windows only
        import win32crypt

        try:
            _desc, data = win32crypt.CryptUnprotectData(blob, _DPAPI_ENTROPY, None, None, CRYPTPROTECT_UI_FORBIDDEN)
        except Exception as e:  # pywintypes.error
            raise SecretProtectorError("DPAPI could not decrypt the stored secret") from e
        return data


class InsecureDevProtector(SecretProtector):
    """Development only. Stores secrets UNENCRYPTED with a marker prefix."""

    name = "insecure-dev"
    _PREFIX = b"INSECURE-DEV:"

    def protect(self, plaintext: bytes) -> bytes:
        return self._PREFIX + plaintext

    def unprotect(self, blob: bytes) -> bytes:
        if not blob.startswith(self._PREFIX):
            raise SecretProtectorError("blob was not written by the insecure-dev protector")
        return blob[len(self._PREFIX):]


def make_protector(kind: str) -> SecretProtector:
    if kind == "dpapi":
        return DpapiMachineProtector()
    if kind == "insecure-dev":
        return InsecureDevProtector()
    raise SecretProtectorError(f"unknown secret protector {kind!r}")
