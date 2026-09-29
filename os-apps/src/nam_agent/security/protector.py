"""Secret protection at rest.

Production uses Windows DPAPI with machine scope (CRYPTPROTECT_LOCAL_MACHINE):
the blob can be decrypted only on this machine, and the ProgramData ACL
(SYSTEM + Administrators only) keeps standard users away from the blob itself.

`InsecureDevProtector` exists solely for development/tests on non-Windows
hosts. It performs NO encryption and must be selected explicitly with
NAM_SECRET_PROTECTOR=insecure-dev.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import stat
from abc import ABC, abstractmethod
from pathlib import Path

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


class FileKeyProtector(SecretProtector):
    """macOS (and other POSIX) protector at rest.

    Encrypts each secret with a machine-local 256-bit key kept in a `0600` key file
    inside the ACL-protected data directory (the POSIX analogue of Windows DPAPI's
    machine scope). Construction: HMAC-SHA256 keystream in counter mode, XORed with
    the plaintext, plus an encrypt-then-MAC HMAC-SHA256 tag for integrity. The blob
    cannot be decrypted without the key file, so copying `policy.db` alone to another
    machine does not expose the secrets.

    This is an honest at-rest protection, not obfuscation: the value is genuinely
    encrypted and authenticated. On macOS the key file additionally sits under
    `/Library/Application Support/OrganizationNetworkAgent`, which the installer
    restricts to root.
    """

    name = "file-key"
    _MAGIC = b"FK1"
    _KEY_BYTES = 32
    _NONCE_BYTES = 16
    _TAG_BYTES = 32
    KEY_FILENAME = "secret.key"

    def __init__(self, key_dir: Path) -> None:
        self._key_path = Path(key_dir) / self.KEY_FILENAME
        self._key = self._load_or_create_key()

    def _load_or_create_key(self) -> bytes:
        if self._key_path.exists():
            key = self._key_path.read_bytes()
            if len(key) != self._KEY_BYTES:
                raise SecretProtectorError(f"secret key file {self._key_path} is corrupt")
            return key
        key = os.urandom(self._KEY_BYTES)
        self._key_path.parent.mkdir(parents=True, exist_ok=True)
        # Create with 0600 from the start (umask-independent), then write.
        fd = os.open(str(self._key_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
        try:
            os.write(fd, key)
        finally:
            os.close(fd)
        try:
            os.chmod(self._key_path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:  # pragma: no cover - platform dependent
            pass
        return key

    def _keystream(self, nonce: bytes, length: int) -> bytes:
        out = bytearray()
        counter = 0
        while len(out) < length:
            block = hmac.new(self._key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest()
            out.extend(block)
            counter += 1
        return bytes(out[:length])

    def protect(self, plaintext: bytes) -> bytes:
        nonce = os.urandom(self._NONCE_BYTES)
        ciphertext = bytes(a ^ b for a, b in zip(plaintext, self._keystream(nonce, len(plaintext))))
        tag = hmac.new(self._key, self._MAGIC + nonce + ciphertext, hashlib.sha256).digest()
        return self._MAGIC + nonce + tag + ciphertext

    def unprotect(self, blob: bytes) -> bytes:
        header = len(self._MAGIC) + self._NONCE_BYTES + self._TAG_BYTES
        if not blob.startswith(self._MAGIC) or len(blob) < header:
            raise SecretProtectorError("blob was not written by the file-key protector")
        nonce = blob[len(self._MAGIC):len(self._MAGIC) + self._NONCE_BYTES]
        tag = blob[len(self._MAGIC) + self._NONCE_BYTES:header]
        ciphertext = blob[header:]
        expected = hmac.new(self._key, self._MAGIC + nonce + ciphertext, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected):
            raise SecretProtectorError("file-key protector could not authenticate the stored secret")
        return bytes(a ^ b for a, b in zip(ciphertext, self._keystream(nonce, len(ciphertext))))


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


def make_protector(kind: str, *, key_dir: Path | None = None) -> SecretProtector:
    if kind == "dpapi":
        return DpapiMachineProtector()
    if kind == "file-key":
        if key_dir is None:
            raise SecretProtectorError("the file-key protector requires a key directory")
        return FileKeyProtector(key_dir)
    if kind == "insecure-dev":
        return InsecureDevProtector()
    raise SecretProtectorError(f"unknown secret protector {kind!r}")
