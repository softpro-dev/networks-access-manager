"""Certificates for the local redirect server (Redirection restrictions on Windows).

A redirect such as kitabghor.com → youtube.com cannot work by pointing the hosts file at the
target: HTTPS makes the browser check that the server really is kitabghor.com. So the service
answers those names itself (redirect_server.py) with a certificate the browser trusts:

* a fresh **root CA** is generated per rule set and added to the machine's Trusted Root store;
* it is **name-constrained** to the redirect source domains only (it cannot vouch for any other
  site, even in principle);
* it signs one server certificate for exactly the redirected names, and then its **private key is
  discarded** — it never touches the disk, so nothing on the machine can sign anything else with it.

Changing the redirect names produces a new CA; the old one is removed from the store.
Pure Python (`cryptography`), no Windows calls: installing into the store is done by the backend.
"""

from __future__ import annotations

import datetime as dt
import hashlib
from dataclasses import dataclass

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

#: Server certificates are re-issued this long before they expire.
RENEW_BEFORE = dt.timedelta(days=30)
VALIDITY = dt.timedelta(days=397)
CA_COMMON_NAME = "SoftProIt Network Redirect CA"


@dataclass(frozen=True)
class RedirectCerts:
    names: tuple[str, ...]
    ca_der: bytes
    #: SHA-1 of the CA certificate (what `certutil -delstore Root <thumbprint>` takes)
    ca_thumbprint: str
    #: server certificate followed by the CA certificate (PEM chain)
    chain_pem: bytes
    key_pem: bytes
    not_after: dt.datetime


def permitted_domains(names: tuple[str, ...] | list[str]) -> list[str]:
    """Smallest set of domains whose subtrees cover every name (for the CA's name constraints)."""
    out: list[str] = []
    for n in sorted(set(names), key=lambda s: (s.count("."), s)):
        if not any(n == d or n.endswith("." + d) for d in out):
            out.append(n)
    return sorted(out)


def make_redirect_certs(names: list[str] | tuple[str, ...], now: dt.datetime | None = None) -> RedirectCerts:
    names = tuple(sorted(set(n.lower() for n in names)))
    if not names:
        raise ValueError("no redirect names")
    now = now or dt.datetime.now(dt.timezone.utc)
    not_before, not_after = now - dt.timedelta(hours=1), now + VALIDITY

    ca_key = ec.generate_private_key(ec.SECP256R1())  # used below, then dropped with this frame
    ca_subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, CA_COMMON_NAME),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SoftProIt Network (local, redirects only)"),
        ]
    )
    ca_ski = x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key())
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_subject)
        .issuer_name(ca_subject)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False, key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.NameConstraints(permitted_subtrees=[x509.DNSName(d) for d in permitted_domains(names)], excluded_subtrees=None),
            critical=True,
        )
        .add_extension(ca_ski, critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])]))
        .issuer_name(ca_subject)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in names]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=False, key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(ca_ski), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(leaf_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    del ca_key

    ca_der = ca_cert.public_bytes(serialization.Encoding.DER)
    return RedirectCerts(
        names=names,
        ca_der=ca_der,
        ca_thumbprint=hashlib.sha1(ca_der).hexdigest().upper(),  # noqa: S324 - certificate thumbprint, not security
        chain_pem=leaf.public_bytes(serialization.Encoding.PEM) + ca_cert.public_bytes(serialization.Encoding.PEM),
        key_pem=leaf_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ),
        not_after=not_after,
    )
