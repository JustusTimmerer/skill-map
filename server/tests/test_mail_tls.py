"""Mail over TLS: SMTP_SECURITY "tls" (implicit TLS, as on port 465) and "starttls" (as on port 587).

mailpit of the stack speaks plain SMTP only, so these tests start their own small SMTP server with TLS in the
tests container (SmtpServer). Its certificate comes from a test CA that the tests make with the openssl command
line tool of the image. The app checks the certificate of a mail server against the CAs of the system, so each test
names the test CA in SSL_CERT_FILE: the code under test stays the same as on a server.

The tests prove that a mail goes out only inside TLS, that the app checks the certificate and the host name, that
STARTTLS is not optional once it is configured, and that the login to the mail server happens inside TLS. A login
without TLS never happens: SMTP_USER with SMTP_SECURITY none stops the app at its start."""
from __future__ import annotations

import base64
import email
import email.policy
import logging
import shutil
import smtplib
import socket
import ssl
import subprocess
import threading
from pathlib import Path

import pytest
from conftest import BASE, PASSWORD, unique

from app import mail
from app.config import Settings
from app.main import create_app

SMTP_USER = "mailer"
SMTP_PASSWORD = "smtp secret of the test"


def _openssl(*args: str, cwd: Path) -> None:
    subprocess.run(["openssl", *args], cwd=cwd, check=True, capture_output=True, timeout=60)


def _issue(folder: Path, name: str, hosts: str) -> dict:
    """A CA and a server certificate signed by it, for the names in hosts (a subjectAltName value)."""
    folder.mkdir(parents=True)
    curve = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"]
    _openssl("req", "-x509", *curve, "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", f"/CN={name} CA",
             "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
             cwd=folder)
    _openssl("req", *curve, "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost", cwd=folder)
    (folder / "server.ext").write_text(
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n"
        f"subjectAltName={hosts}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n", encoding="ascii")
    _openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
             "-out", "server.crt", "-days", "2", "-extfile", "server.ext", cwd=folder)
    return {"ca": str(folder / "ca.crt"), "cert": str(folder / "server.crt"), "key": str(folder / "server.key")}


@pytest.fixture(scope="module")
def certificates(tmp_path_factory) -> dict:
    """trusted: the CA that the tests trust and its certificate for localhost. stranger: a certificate for localhost
    from a CA that nobody trusts."""
    assert shutil.which("openssl"), "the tests image needs the openssl command line tool"
    root = tmp_path_factory.mktemp("smtp-tls")
    return {"trusted": _issue(root / "trusted", "skill-map test", "DNS:localhost"),
            "stranger": _issue(root / "stranger", "stranger", "DNS:localhost")}


class SmtpServer:
    """A small SMTP server on 127.0.0.1 for these tests. mode "tls" speaks TLS from the first byte, "starttls" offers
    STARTTLS, and "none" offers neither. With a user it offers AUTH PLAIN, but only inside TLS, as a real mail server
    does. plain_auth=True offers AUTH PLAIN without TLS too, as a server does whose STARTTLS somebody strips on the way.
    Each mail is kept with the facts of its session: whether TLS was on, and who signed in."""

    def __init__(self, mode: str, certificate: dict | None = None, user: str = "", password: str = "",
                 plain_auth: bool = False):
        self.mode, self.user, self.password, self.plain_auth = mode, user, password, plain_auth
        self.context = None
        if certificate:
            self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            self.context.load_cert_chain(certificate["cert"], certificate["key"])
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.mails: list[dict] = []
        self.commands: list[str] = []
        self.errors: list[Exception] = []
        threading.Thread(target=self._serve, daemon=True).start()

    def close(self) -> None:
        self.listener.close()

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            connection.settimeout(10)
            threading.Thread(target=self._session, args=(connection,), daemon=True).start()

    def _session(self, sock: socket.socket) -> None:
        state = {"tls": False, "auth": None, "from": None, "to": []}
        try:
            if self.mode == "tls":
                sock = self.context.wrap_socket(sock, server_side=True)
                state["tls"] = True
            reader = sock.makefile("rb")

            def send(line: str) -> None:
                sock.sendall(line.encode("ascii") + b"\r\n")

            send("220 localhost ESMTP test server")
            while True:
                line = reader.readline()
                if not line:
                    return
                command = line.decode("utf-8").rstrip("\r\n")
                verb = command.split(" ", 1)[0].upper()
                self.commands.append(verb + (" (tls)" if state["tls"] else ""))
                if verb in ("EHLO", "HELO"):
                    features = ["localhost"]
                    if self.mode == "starttls" and not state["tls"]:
                        features.append("STARTTLS")
                    if self.user and (state["tls"] or self.plain_auth):
                        features.append("AUTH PLAIN")
                    features.append("8BITMIME")
                    for number, feature in enumerate(features):
                        send(("250 " if number == len(features) - 1 else "250-") + feature)
                elif verb == "STARTTLS" and self.mode == "starttls" and not state["tls"]:
                    send("220 ready for TLS")
                    sock = self.context.wrap_socket(sock, server_side=True)
                    state["tls"] = True
                    reader = sock.makefile("rb")
                elif verb == "AUTH" and self.user and (state["tls"] or self.plain_auth):
                    parts = command.split(" ")
                    secret = base64.b64decode(parts[2]).split(b"\0") if len(parts) == 3 else []
                    if parts[1].upper() == "PLAIN" and secret[1:] == [self.user.encode(), self.password.encode()]:
                        state["auth"] = self.user
                        send("235 2.7.0 signed in")
                    else:
                        send("535 5.7.8 wrong user or password")
                elif verb == "MAIL":
                    if self.user and not state["auth"]:
                        send("530 5.7.0 sign in first")
                        continue
                    state["from"], state["to"] = command[10:].strip(), []
                    send("250 ok")
                elif verb == "RCPT":
                    state["to"].append(command[8:].strip())
                    send("250 ok")
                elif verb == "DATA":
                    send("354 end with a line with a dot")
                    lines = []
                    while (data := reader.readline()) not in (b".\r\n", b""):
                        lines.append(data[1:] if data.startswith(b"..") else data)
                    message = email.message_from_bytes(b"".join(lines), policy=email.policy.default)
                    self.mails.append({**state, "to": list(state["to"]), "message": message})
                    send("250 queued")
                elif verb in ("RSET", "NOOP"):
                    send("250 ok")
                elif verb == "QUIT":
                    send("221 bye")
                    return
                else:
                    send("502 5.5.2 not offered")
        except (OSError, ssl.SSLError, ValueError) as error:
            self.errors.append(error)
        finally:
            sock.close()


@pytest.fixture
def smtp_server(certificates, monkeypatch):
    """Starts SmtpServer with the certificate of the trusted CA (or another one) and trusts the test CA. Every server
    stops at the end of the test."""
    monkeypatch.setenv("SSL_CERT_FILE", certificates["trusted"]["ca"])
    servers = []

    def start(mode: str, certificate: str = "trusted", **kwargs) -> SmtpServer:
        server = SmtpServer(mode, certificates[certificate] if mode != "none" else None, **kwargs)
        servers.append(server)
        return server
    yield start
    for server in servers:
        server.close()


def _settings(server: SmtpServer, security: str, host: str = "localhost", **changes) -> Settings:
    return Settings(base_url=BASE, smtp_host=host, smtp_port=server.port, smtp_security=security, **changes)


@pytest.mark.parametrize("security", ["tls", "starttls"])
def test_a_mail_goes_out_only_inside_tls(smtp_server, security):
    server = smtp_server(security)
    mail.send(_settings(server, security), "anna@example.org", "Betreff über TLS", "Hallo über TLS.\n")
    assert len(server.mails) == 1
    sent = server.mails[0]
    assert sent["tls"] is True and sent["to"] == ["<anna@example.org>"]
    assert sent["message"]["Subject"] == "Betreff über TLS"
    assert sent["message"].get_content().startswith("Hallo über TLS.")
    if security == "starttls":
        # The client asks for TLS right after the greeting, and says EHLO again inside TLS before the mail.
        assert server.commands[:3] == ["EHLO", "STARTTLS", "EHLO (tls)"]
        assert all(c.endswith("(tls)") for c in server.commands[2:])
    else:
        assert all(c.endswith("(tls)") for c in server.commands)


@pytest.mark.parametrize("security", ["tls", "starttls"])
def test_the_login_to_the_mail_server_happens_inside_tls(smtp_server, security):
    server = smtp_server(security, user=SMTP_USER, password=SMTP_PASSWORD)
    settings = _settings(server, security, smtp_user=SMTP_USER, smtp_password=SMTP_PASSWORD)
    mail.send(settings, "bert@example.org", "Mit Anmeldung", "Text\n")
    assert [m["auth"] for m in server.mails] == [SMTP_USER] and server.mails[0]["tls"] is True
    assert "AUTH (tls)" in server.commands and "AUTH" not in server.commands
    with pytest.raises(smtplib.SMTPAuthenticationError):
        mail.send(_settings(server, security, smtp_user=SMTP_USER, smtp_password="wrong"), "bert@example.org", "X", "X")
    assert len(server.mails) == 1


@pytest.mark.parametrize("security", ["tls", "starttls"])
def test_a_certificate_of_an_unknown_ca_stops_the_mail(smtp_server, security):
    server = smtp_server(security, certificate="stranger")
    with pytest.raises(ssl.SSLCertVerificationError, match="certificate verify failed"):
        mail.send(_settings(server, security), "anna@example.org", "Nie", "Nie\n")
    assert server.mails == []


@pytest.mark.parametrize("security", ["tls", "starttls"])
def test_a_certificate_for_another_host_stops_the_mail(smtp_server, security):
    # The certificate names localhost, the app connects to 127.0.0.1: the same server under a name it does not hold.
    server = smtp_server(security)
    with pytest.raises(ssl.SSLCertVerificationError, match="IP address mismatch|Hostname mismatch"):
        mail.send(_settings(server, security, host="127.0.0.1"), "anna@example.org", "Nie", "Nie\n")
    assert server.mails == []


def test_starttls_is_not_optional(smtp_server):
    # A mail server that does not offer STARTTLS, for example because somebody strips it on the way: no mail goes out
    # in plain text.
    server = smtp_server("none")
    with pytest.raises(smtplib.SMTPNotSupportedError):
        mail.send(_settings(server, "starttls"), "anna@example.org", "Nie", "Nie\n")
    assert server.mails == [] and "MAIL" not in server.commands


def test_starttls_without_the_offer_sends_no_password(smtp_server):
    # The server offers no STARTTLS but a login in plain text. With SMTP_SECURITY=starttls, the mail stops before the
    # login: the password never goes out in plain text.
    server = smtp_server("none", user=SMTP_USER, password=SMTP_PASSWORD, plain_auth=True)
    with pytest.raises(smtplib.SMTPNotSupportedError):
        mail.send(_settings(server, "starttls", smtp_user=SMTP_USER, smtp_password=SMTP_PASSWORD), "anna@example.org",
                  "Nie", "Nie\n")
    assert server.mails == [] and "AUTH" not in server.commands and "MAIL" not in server.commands


def test_a_login_without_tls_stops_the_app_at_its_start(monkeypatch):
    """SMTP_USER with SMTP_SECURITY=none would send the password of the mail server in plain text. The settings refuse
    it, so the app does not start, and the error names both settings. Without SMTP_USER, as with mailpit of the local
    stack, SMTP_SECURITY=none works."""
    for env in ({"BASE_URL": BASE, "SMTP_USER": SMTP_USER, "SMTP_PASSWORD": SMTP_PASSWORD},
                {"BASE_URL": BASE, "SMTP_USER": SMTP_USER, "SMTP_SECURITY": "none"}):
        with pytest.raises(ValueError, match="SMTP_USER is set, but SMTP_SECURITY is none"):
            Settings.from_env(env)
    with pytest.raises(ValueError, match="SMTP_SECURITY to starttls or tls"):
        Settings(base_url=BASE, smtp_user=SMTP_USER)
    for security in ("starttls", "tls"):
        assert Settings.from_env({"BASE_URL": BASE, "SMTP_USER": SMTP_USER, "SMTP_SECURITY": security}).smtp_user
    assert Settings.from_env({"BASE_URL": BASE, "SMTP_HOST": "mailpit", "SMTP_PORT": "1025"}).smtp_security == "none"
    # The start command of the image builds the app from the environment (create_app with no settings).
    monkeypatch.setenv("BASE_URL", BASE)
    monkeypatch.setenv("SMTP_USER", SMTP_USER)
    monkeypatch.setenv("SMTP_SECURITY", "none")
    with pytest.raises(ValueError, match="SMTP_USER is set, but SMTP_SECURITY is none"):
        create_app()


def test_the_app_never_logs_in_without_tls(smtp_server):
    # A second guard behind the check of the settings: send() logs in only over a TLS connection. Settings that got past
    # the check, here by force, stop the mail before the login.
    server = smtp_server("none", user=SMTP_USER, password=SMTP_PASSWORD, plain_auth=True)
    settings = _settings(server, "starttls", smtp_user=SMTP_USER, smtp_password=SMTP_PASSWORD)
    object.__setattr__(settings, "smtp_security", "none")
    with pytest.raises(smtplib.SMTPException, match="without TLS"):
        mail.send(settings, "anna@example.org", "Nie", "Nie\n")
    assert server.mails == [] and "AUTH" not in server.commands


def test_implicit_tls_does_not_fall_back_to_plain_smtp(smtp_server):
    server = smtp_server("none")
    with pytest.raises(ssl.SSLError):
        mail.send(_settings(server, "tls"), "anna@example.org", "Nie", "Nie\n")
    assert server.mails == []


def test_a_tls_failure_goes_to_the_log_and_not_to_the_caller(smtp_server, caplog):
    server = smtp_server("tls", certificate="stranger")
    with caplog.at_level(logging.ERROR, logger="skill-map.mail"):
        mail.send_quietly(_settings(server, "tls"), "anna@example.org", "Leise", "Leise\n")
    assert server.mails == []
    assert [r.getMessage() for r in caplog.records] == ["could not send the mail 'Leise'"]


@pytest.mark.parametrize("security", ["tls", "starttls"])
def test_the_app_sends_the_mail_of_a_registration_over_tls(smtp_server, make_app, make_client, security):
    server = smtp_server(security, user=SMTP_USER, password=SMTP_PASSWORD)
    app = make_app(smtp_host="localhost", smtp_port=server.port, smtp_security=security, smtp_user=SMTP_USER,
                   smtp_password=SMTP_PASSWORD)
    handle = unique("tls")
    response = make_client(app).post("/api/auth/register",
                                     json={"email": f"{handle}@example.org", "password": PASSWORD, "handle": handle})
    assert response.status_code == 202
    assert len(server.mails) == 1 and server.mails[0]["tls"] is True and server.mails[0]["auth"] == SMTP_USER
    sent = server.mails[0]["message"]
    assert sent["To"] == f"{handle}@example.org" and sent["Subject"] == "Please confirm your account at it-skills.test"
    assert "/account#confirm=" in sent.get_content()
