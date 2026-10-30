"""The running stack through the reverse proxy, with TLS: the static site, the routes to the app, the
subdomains, and one public map from registration to the subdomain. These tests need `docker compose up`.

They talk to the proxy service by its name and send the host names of the site in SNI and in the Host
header, and they check the certificate against the local CA of the proxy."""
from __future__ import annotations

import os
import re
import ssl
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx2
import pytest

from app.pages import SITE_POLICY, site_policy
from conftest import SUBJECTS

STACK_URL = os.environ.get("STACK_URL", "")
BASE_URL = os.environ.get("STACK_BASE_URL", "https://it-skills.localhost:8443")
SITE_HOST = os.environ.get("STACK_SITE_HOST", "it-skills.localhost")
BASE_DOMAIN = os.environ.get("STACK_BASE_DOMAIN", "")
CA_FILE = os.environ.get("STACK_CA_FILE", "")
STACK_HTTPS_PORT = os.environ.get("STACK_HTTPS_PORT", "")
DEPLOY_FILE = os.environ.get("DEPLOY_FILE", "")

pytestmark = pytest.mark.skipif(not STACK_URL, reason="STACK_URL is not set (run the tests in the compose stack)")

PORT = urlsplit(BASE_URL).port
WRITE = {"X-Requested-With": "it-skills", "Origin": BASE_URL}


@pytest.fixture(scope="module")
def tls() -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=CA_FILE)
    return context


class Site:
    """Requests to one host name of the site, sent to the proxy service."""

    def __init__(self, host: str, tls: ssl.SSLContext):
        self.host = host
        self.http = httpx2.Client(base_url=STACK_URL, verify=tls, timeout=15, follow_redirects=False)

    def request(self, method: str, path: str, **kwargs):
        headers = {"Host": f"{self.host}:{PORT}" if PORT else self.host, **kwargs.pop("headers", {})}
        return self.http.request(method, path, headers=headers, extensions={"sni_hostname": self.host}, **kwargs)

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, **kwargs):
        return self.request("POST", path, **{"headers": WRITE, **kwargs})

    def patch(self, path, **kwargs):
        return self.request("PATCH", path, **{"headers": WRITE, **kwargs})


@pytest.fixture(scope="module")
def site(tls) -> Site:
    return Site(SITE_HOST, tls)


def test_static_site_over_tls(site):
    # The start page comes through the app, which names the server in it; the files come from the static site.
    response = site.get("/")
    assert response.status_code == 200
    assert "Skill-Map" in response.text and '"mode": "site"' in response.text
    assert response.headers.get("x-content-type-options") == "nosniff"
    assert site.get("/assets/site.css").status_code == 200
    assert 'id="it-skills-server"' not in site.get("/map.html").text
    assert site.get("/server-map.html").status_code == 200


def test_proxy_passes_the_app_routes(site):
    assert site.get("/api/health").json() == {"status": "ok"}
    assert site.get("/account").status_code == 200
    response = site.get("/nobody-here")
    assert response.status_code == 404 and '<p data-i18n="error.not_found">Not found.</p>' in response.text
    assert site.get("/s/no-such-token").status_code == 404
    assert site.get("/does-not-exist.html").status_code == 404


def test_framing_headers_through_the_proxy(site):
    # The files of the site and the pages of the app block other sites; the embed addresses reach the app.
    for path in ("/map.html", "/server-map.html", "/assets/site.css", "/", "/account", "/nobody-here"):
        response = site.get(path)
        policy = response.headers.get("content-security-policy", "")
        assert "frame-ancestors 'self'" in policy or "frame-ancestors 'none'" in policy, (path, policy)
        assert response.headers.get("x-frame-options") in ("SAMEORIGIN", "DENY"), path
    missing = site.get("/e/nobody-here/no-map")
    assert missing.status_code == 404 and "This map does not exist" in missing.text
    assert missing.headers["content-security-policy"] == site_policy("*")
    assert site.get("/e/s/no-such-token").status_code == 404


def test_one_policy_in_the_pages_the_proxy_and_the_app(site):
    # The policy has three copies: the meta tag of each page (build_selfhost.js), the header of the proxy for the files of
    # the site (proxy/Caddyfile) and the header of the app (SITE_POLICY in app/pages.py). They differ only in base-uri,
    # because the app adds <base href="/">, and in frame-ancestors, which a meta tag cannot hold.
    meta = re.compile(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">')
    for path in ("/example.html", "/map.html", "/server-map.html", "/imprint.html"):
        response = site.get(path)
        assert response.status_code == 200, path
        assert response.headers["content-security-policy"] == f"{SITE_POLICY}; base-uri 'none'; frame-ancestors 'self'", path
        assert meta.search(response.text)[1] == f"{SITE_POLICY}; base-uri 'none'", path
    start = site.get("/")
    assert start.headers["content-security-policy"] == site_policy("'self'")
    assert meta.search(start.text)[1] == f"{SITE_POLICY}; base-uri 'none'"
    assert "script-src 'self';" in SITE_POLICY and "unsafe-inline" not in SITE_POLICY.split("style-src")[0]


def test_csrf_through_the_proxy(site):
    response = site.request("POST", "/api/maps", json={"title": "x"})
    assert response.status_code == 403 and response.json()["error"] == "csrf"


def test_the_proxy_sends_the_addresses_to_the_app_and_the_files_to_the_site(site):
    # /<handle> and /<handle>/<slug> reach the app, which answers an unknown handle with its 404 page. A path with a dot
    # or below a folder of the site is a file of the site. /u is gone: /u/<name> is no address of a handle.
    for path in ("/nobody-here", "/nobody-here/no-map", "/vendor", "/vendor/no-file", "/u/nobody-here"):
        response = site.get(path)
        assert response.status_code == 404 and '<p data-i18n="error.not_found">Not found.</p>' in response.text, path
    assert site.get("/vendor/licenses/d3-ISC.txt").status_code == 200
    assert site.get("/assets/site.css").headers["content-type"].startswith("text/css")
    for path in ("/u/nobody-here/no-map", "/nobody-here/no-map/more", "/Nobody"):
        response = site.get(path)
        assert response.status_code == 404 and "error.not_found" not in response.text, path


def test_a_slash_at_the_end_through_the_proxy(site):
    # Finding B3 of the final review: the app answered a path with "/" at the end with a redirect to http:// and the
    # whole path, because the proxy talks plain HTTP to it. Now a page gets a 308 to its address on BASE_URL, and the API
    # gets 404. The proxy passes /<handle>/ and /<handle>/<slug>/ to the app too.
    for path, target in (("/nobody-here/", "/nobody-here"), ("/nobody-here/no-map/", "/nobody-here/no-map"),
                         ("/s/no-such-token/", "/s/no-such-token"), ("/e/s/no-such-token/?lang=de", "/e/s/no-such-token?lang=de"),
                         ("/account/", "/account")):
        response = site.get(path)
        assert response.status_code == 308 and response.headers["location"] == BASE_URL + target, (path, response.status_code)
    for path in ("/api/shared/no-such-token/docs/", "/api/maps/", "/api/health/"):
        response = site.get(path)
        assert response.status_code == 404 and response.json()["error"] == "not_found", path
        assert "location" not in response.headers, path


@pytest.mark.skipif(not BASE_DOMAIN or SITE_HOST == f"www.{BASE_DOMAIN}",
                    reason="no subdomains, or www is the main host and gets the main site")
def test_reserved_names_under_the_wildcard_through_the_proxy(tls):
    # Finding A5: www and api under the wildcard served the main site, and each write there failed with 403 csrf.
    www = Site(f"www.{BASE_DOMAIN}", tls)
    for path in ("/", "/example.html?x=1&y=%C3%A4", "/assets/site.css", "/api/health", "/anna/karte"):
        response = www.get(path)
        assert response.status_code == 308 and response.headers["location"] == BASE_URL + path, path
    origin = f"https://www.{BASE_DOMAIN}" + (f":{PORT}" if PORT else "")
    response = www.post("/api/maps", json={"title": "x"}, headers={**WRITE, "Origin": origin})
    assert response.status_code == 308 and response.headers["location"] == BASE_URL + "/api/maps"
    for name in ("api", "mail", "vendor"):
        reserved = Site(f"{name}.{BASE_DOMAIN}", tls)
        for path in ("/", "/index.html", "/example.html", "/assets/site.css", "/account", "/nobody-here", "/api/health"):
            assert reserved.get(path).status_code == 404, (name, path)
        response = reserved.post("/api/auth/login", json={"email": "x@example.org", "password": "x"})
        assert response.status_code == 404 and response.json()["error"] == "not_found", name


@pytest.mark.skipif(not BASE_DOMAIN, reason="BASE_DOMAIN is empty, so there are no subdomains")
def test_public_map_from_registration_to_subdomain(site, tls, mailbox, sample_file):
    handle = "e2e-" + uuid.uuid4().hex[:8]
    email = f"{handle}@example.org"
    password = "ein Passwort nur für den Test"
    response = site.post("/api/auth/register", json={"email": email, "password": password, "handle": handle})
    assert response.status_code == 202, response.text
    token = mailbox.token(email, "confirm")
    assert BASE_URL + "/account#confirm=" in mailbox.wait(email, SUBJECTS["confirm"])["Text"]
    assert site.post("/api/auth/confirm", json={"token": token, "password": password}).status_code == 200
    login = site.post("/api/auth/login", json={"email": email, "password": password})
    assert login.status_code == 200
    cookie = {"Cookie": "__Host-session=" + login.cookies["__Host-session"]}
    try:
        created = site.post("/api/maps/import", json=sample_file, headers={**WRITE, **cookie}).json()
        site.patch(f"/api/maps/{created['id']}", json={"visibility": "public"}, headers={**WRITE, **cookie})
        user_site = Site(f"{handle}.{BASE_DOMAIN}", tls)
        listing = user_site.get("/")
        assert listing.status_code == 200 and f'href="/{created["slug"]}"' in listing.text
        page = user_site.get(f"/{created['slug']}")
        assert page.status_code == 200 and 'id="it-skills-server"' in page.text and "assets/runtime-server.js" in page.text
        docs = user_site.get(f"/api/public/{handle}/{created['slug']}/docs").json()
        assert len(docs["docs"]) == sum(len(c) for c in sample_file["collections"].values())
        assert user_site.get("/assets/runtime-server.js").status_code == 200
        assert site.get(f"/{handle}/{created['slug']}").status_code == 200
        # The embed view through the proxy keeps the policy of the app, and the subdomain has none.
        framed = site.get(f"/e/{handle}/{created['slug']}")
        assert framed.status_code == 200 and '"mode": "embed"' in framed.text and "assets/embed.js" in framed.text
        assert framed.headers["content-security-policy"] == site_policy("*") and "x-frame-options" not in framed.headers
        assert user_site.get(f"/e/{handle}/{created['slug']}").status_code == 404
        # The start map: the address of the owner and the root of the subdomain show it. The client of the main domain
        # keeps the cookie of the login, so it gets the page of the owner there.
        site.patch(f"/api/maps/{created['id']}", json={"start": True}, headers={**WRITE, **cookie})
        for start, mode in ((site.get(f"/{handle}"), "owner"), (user_site.get("/"), "public")):
            assert start.status_code == 200 and f'"mode": "{mode}"' in start.text and f'"slug": "{created["slug"]}"' in start.text, mode
    finally:
        response = site.post("/api/account/delete", json={"password": password}, headers={**WRITE, **cookie})
        assert response.status_code == 204
    assert site.get(f"/{handle}").status_code == 404


def test_an_address_with_a_version_is_kept_only_when_its_file_exists(site):
    # Finding E4: the proxy sent "immutable" on every answer of a ?v= address, also on a 404. A page that loads while a
    # build runs then kept the 404 of its scripts for a year. Every error now gets no-store.
    page = site.get("/map.html").text
    address = re.search(r'src="(vendor/d3-[^"?]+\?v=[0-9a-f]+)"', page)[1]
    found = site.get("/" + address)
    assert found.status_code == 200 and found.headers["cache-control"] == "public, max-age=31536000, immutable"
    for path in ("/vendor/no-such-file.js?v=0123456789ab", "/assets/no-such-style.css?v=0123456789ab", "/no-such-page.html"):
        response = site.get(path)
        assert response.status_code == 404 and response.headers.get("cache-control") == "no-store", (path, response.headers)
        assert "server" not in response.headers, path


@pytest.mark.skipif(not STACK_HTTPS_PORT, reason="STACK_HTTPS_PORT is not set")
def test_http3_is_announced_on_the_https_port_of_the_host(site):
    # Finding E10: Caddy announced h3=":443" inside the container, and compose published no UDP port. Caddy now listens
    # on the port of the host, and compose publishes it on TCP and UDP (tests/server/deploy.js checks the published ports).
    announced = re.findall(r'h3=":(\d+)"', site.get("/map.html").headers.get("alt-svc", ""))
    assert announced == [STACK_HTTPS_PORT]


def _code_blocks(text: str) -> list[str]:
    return re.findall(r"^```\n(.*?)^```$", text, re.S | re.M)


@pytest.mark.skipif(not DEPLOY_FILE, reason="DEPLOY_FILE is not set")
def test_the_web_server_lines_of_deploy_send_the_policy_of_the_site():
    # Findings C2 and E12: the lines for Apache and nginx in selfhost/DEPLOY.md sent no policy and no X-Frame-Options, so
    # another site could frame stage a on a static host. They are the fourth and fifth copy of the policy.
    text = Path(DEPLOY_FILE).read_text(encoding="utf-8").replace("\r", "")
    section = text[text.index("\n## Recommended headers\n"):]
    section = section[:section.index("\n## ", 5)]
    policy = f"{SITE_POLICY}; base-uri 'none'; frame-ancestors 'self'"
    after = lambda start: _code_blocks(section[section.index("\n" + start):])[0]  # noqa: E731
    listed, apache, nginx = _code_blocks(section)[0], after("For Apache 2.4"), after("For nginx")
    assert f"Content-Security-Policy: {policy}\n" in listed and "X-Frame-Options: SAMEORIGIN\n" in listed
    assert f'Header always set Content-Security-Policy "{policy}"\n' in apache
    assert 'Header always set X-Frame-Options "SAMEORIGIN"\n' in apache
    assert f'add_header Content-Security-Policy "{policy}" always;\n' in nginx
    assert "add_header X-Frame-Options SAMEORIGIN always;\n" in nginx
    assert "charset utf-8;\n" in nginx and re.search(r"charset_types [^;]*\btext/css\b[^;]*\bjavascript\b", nginx)
