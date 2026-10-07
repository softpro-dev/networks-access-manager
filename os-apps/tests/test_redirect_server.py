"""Local redirect server + its certificates, over real sockets with real TLS verification."""

from __future__ import annotations

import socket
import ssl

import pytest
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding, load_pem_private_key

from nam_agent.enforcement.redirect_certs import make_redirect_certs, permitted_domains
from nam_agent.enforcement.redirect_server import RedirectServer

NAMES = ["www.kitabghor.com", "kitabghor.com", "m.kitabghor.com"]


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def served(tmp_path):
    certs = make_redirect_certs(NAMES)
    chain, key = tmp_path / "chain.pem", tmp_path / "key.pem"
    chain.write_bytes(certs.chain_pem)
    key.write_bytes(certs.key_pem)
    srv = RedirectServer("127.0.0.1", https_port=free_port(), http_port=free_port())
    assert srv.start({n: "youtube.com" for n in NAMES}, chain, key) == (True, True)
    yield srv, certs
    srv.stop()


def ca_pem(certs) -> str:
    return x509.load_der_x509_certificate(certs.ca_der).public_bytes(Encoding.PEM).decode()


def https_get(port: int, host: str, ca: str) -> str:
    ctx = ssl.create_default_context(cadata=ca)  # verifies chain, hostname and name constraints
    with socket.create_connection(("127.0.0.1", port), timeout=5) as raw, ctx.wrap_socket(raw, server_hostname=host) as s:
        s.sendall(f"GET /some/page HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
        return b"".join(iter(lambda: s.recv(4096), b"")).decode()


def test_https_visit_is_redirected_with_a_trusted_certificate(served):
    srv, certs = served
    for host in NAMES:
        resp = https_get(srv.https_port, host, ca_pem(certs))
        assert resp.startswith("HTTP/1.1 302")
        assert "Location: https://youtube.com/\r\n" in resp
        assert "Cache-Control: no-store" in resp


def test_plain_http_visit_is_redirected(served):
    srv, _ = served
    with socket.create_connection(("127.0.0.1", srv.http_port), timeout=5) as s:
        s.sendall(b"GET / HTTP/1.1\r\nHost: kitabghor.com\r\nConnection: close\r\n\r\n")
        resp = b"".join(iter(lambda: s.recv(4096), b"")).decode()
    assert resp.startswith("HTTP/1.1 302") and "Location: https://youtube.com/" in resp


def test_certificate_is_useless_for_any_other_site(served):
    srv, certs = served
    with pytest.raises(ssl.SSLCertVerificationError):
        https_get(srv.https_port, "www.google.com", ca_pem(certs))


def test_ca_is_name_constrained_and_its_key_is_not_kept():
    certs = make_redirect_certs(NAMES)
    ca = x509.load_der_x509_certificate(certs.ca_der)
    nc = ca.extensions.get_extension_for_class(x509.NameConstraints)
    assert nc.critical and [d.value for d in nc.value.permitted_subtrees] == ["kitabghor.com"]
    assert ca.extensions.get_extension_for_class(x509.BasicConstraints).value.path_length == 0
    # Only the server key leaves make_redirect_certs; it is not the CA's key.
    server_key = load_pem_private_key(certs.key_pem, None)
    assert server_key.public_key().public_numbers() != ca.public_key().public_numbers()
    assert certs.chain_pem.count(b"BEGIN CERTIFICATE") == 2


def test_permitted_domains_collapses_subdomains():
    assert permitted_domains(["www.a.com", "a.com", "m.a.com", "b.org"]) == ["a.com", "b.org"]


def test_unknown_host_gets_404(served):
    srv, _ = served
    with socket.create_connection(("127.0.0.1", srv.http_port), timeout=5) as s:
        s.sendall(b"GET / HTTP/1.1\r\nHost: other.example\r\nConnection: close\r\n\r\n")
        assert b"".join(iter(lambda: s.recv(4096), b"")).startswith(b"HTTP/1.1 404")


def test_port_in_use_is_reported_not_raised(tmp_path):
    certs = make_redirect_certs(NAMES)
    chain, key = tmp_path / "c.pem", tmp_path / "k.pem"
    chain.write_bytes(certs.chain_pem)
    key.write_bytes(certs.key_pem)
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen()
    try:
        srv = RedirectServer("127.0.0.1", https_port=blocker.getsockname()[1], http_port=free_port())
        assert srv.start({"kitabghor.com": "youtube.com"}, chain, key) == (False, True)
        srv.stop()
        assert not srv.running
    finally:
        blocker.close()
