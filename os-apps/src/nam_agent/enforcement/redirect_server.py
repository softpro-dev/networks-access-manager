"""Tiny local web server that turns a visit to a redirected website into a real redirect.

The hosts file points each redirect source (e.g. www.kitabghor.com) at REDIRECT_IP, a loopback
address reserved for this purpose. This server listens there on 443 (HTTPS, certificate from
redirect_certs.py) and 80 (HTTP) and answers every request for a known name with
`302 Location: https://<target>/`. Unknown names get 404. It never forwards, proxies or records
traffic: it only reads the Host header to choose the redirect.

Runs inside the service process (threads), started/stopped by the Windows enforcement backend.
"""

from __future__ import annotations

import logging
import socket
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

log = logging.getLogger(__name__)

#: Dedicated loopback address (all of 127.0.0.0/8 is loopback on Windows), so the redirect server
#: never competes with software listening on 127.0.0.1.
REDIRECT_IP = "127.77.0.1"
REQUEST_TIMEOUT_SECONDS = 10


def _handler(routes: dict[str, str]):
    class RedirectHandler(BaseHTTPRequestHandler):
        server_version = "SoftProItRedirect"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def _redirect(self) -> None:
            host = (self.headers.get("Host") or "").split(":", 1)[0].strip().lower().rstrip(".")
            target = routes.get(host)
            if target is None:
                self.send_response(404)
                self.send_header("Content-Length", "0")
            else:
                self.send_response(302)
                self.send_header("Location", f"https://{target}/")
                self.send_header("Content-Length", "0")
            # Never cached: lifting the restriction must take effect immediately.
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

        do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_OPTIONS = do_PATCH = _redirect

        def log_message(self, format, *args):  # noqa: A002 - no access log (no browsing records)
            pass

    return RedirectHandler


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    # SO_REUSEADDR on Windows would let another process take over the port; use exclusive use instead.
    allow_reuse_address = False

    def __init__(self, addr, handler, tls: ssl.SSLContext | None):
        self.tls = tls
        super().__init__(addr, handler, bind_and_activate=False)
        try:
            if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            self.server_bind()
            self.server_activate()
        except BaseException:
            self.server_close()
            raise

    def finish_request(self, request, client_address):
        request.settimeout(REQUEST_TIMEOUT_SECONDS)
        if self.tls is not None:
            try:
                # Handshake in the per-connection thread, so a slow client never blocks accept().
                request = self.tls.wrap_socket(request, server_side=True)
            except (ssl.SSLError, OSError):
                return
        super().finish_request(request, client_address)

    def handle_error(self, request, client_address):  # quiet: aborted connections are normal
        log.debug("redirect server: connection error", exc_info=True)


class RedirectServer:
    """HTTPS (443) + HTTP (80) redirect listeners on REDIRECT_IP. Either may fail to bind (port in
    use by another web server); `start()` reports which ones are up."""

    def __init__(self, ip: str = REDIRECT_IP, https_port: int = 443, http_port: int = 80):
        self.ip, self.https_port, self.http_port = ip, https_port, http_port
        self._servers: list[_Server] = []
        self._threads: list[threading.Thread] = []
        self.https_ok = False
        self.http_ok = False

    @property
    def running(self) -> bool:
        return bool(self._servers)

    def start(self, routes: dict[str, str], cert_file: Path, key_file: Path) -> tuple[bool, bool]:
        self.stop()
        routes = {k.lower(): v for k, v in routes.items()}
        handler = _handler(routes)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.minimum_version = ssl.TLSVersion.TLSv1_2
        tls.load_cert_chain(str(cert_file), str(key_file))
        self.https_ok = self._listen(self.https_port, handler, tls)
        self.http_ok = self._listen(self.http_port, handler, None)
        return self.https_ok, self.http_ok

    def _listen(self, port: int, handler, tls: ssl.SSLContext | None) -> bool:
        try:
            srv = _Server((self.ip, port), handler, tls)
        except OSError as e:
            log.warning("redirect server: cannot listen on %s:%s (%s); another program uses that port", self.ip, port, e)
            return False
        t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.5}, name=f"redirect-{port}", daemon=True)
        t.start()
        self._servers.append(srv)
        self._threads.append(t)
        return True

    def stop(self) -> None:
        for srv in self._servers:
            try:
                srv.shutdown()
                srv.server_close()
            except Exception:  # noqa: BLE001
                log.debug("redirect server: error while stopping", exc_info=True)
        for t in self._threads:
            t.join(timeout=5)
        self._servers, self._threads = [], []
        self.https_ok = self.http_ok = False
