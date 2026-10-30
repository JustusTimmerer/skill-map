"""Rate limits per e-mail address and per IP: the limit of registrations per address, and IPv6 clients by their /64."""
from __future__ import annotations

import ipaddress

import pytest
from conftest import PASSWORD, SUBJECTS, unique

from app.config import Limit

PROXY = (ipaddress.ip_network("10.0.0.0/8"),)


def register(client, email, handle=None, **kwargs):
    return client.post("/api/auth/register", json={"email": email, "password": PASSWORD, "handle": handle or unique()},
                       **kwargs)


def test_the_register_limit_per_address_is_the_same_for_a_known_and_a_new_address(make_app, make_client, quick_user,
                                                                                  mailbox):
    """Each registration of an address sends a mail to it: the confirmation for a new address, a notice for a known one.
    RATE_LIMIT_REGISTER_ACCOUNT stops them per address, and the answers are the same for both, also at the limit, so
    they do not tell whether the address has an account."""
    app = make_app(limits={"register_account": Limit(2, 3600)})
    known = quick_user().email
    new = f"{unique()}@example.org"
    answers = {}
    for email in (known, new):
        client = make_client(app)
        answers[email] = [(r.status_code, r.json()) for r in (register(client, email) for _ in range(4))]
    assert answers[known] == answers[new]
    assert [status for status, _ in answers[new]] == [202, 202, 429, 429]
    assert answers[new][2][1]["error"] == "rate_limited"
    # Two mails went to each address, and the refused registrations sent none.
    mailbox.wait(known, SUBJECTS["registered"], count=2)
    mailbox.wait(new, SUBJECTS["confirm"], count=2)
    assert len(mailbox.messages(known)) == len(mailbox.messages(new)) == 2
    # Capitals and spaces name the same address, and another IP does not help.
    other_ip = make_client(app, client=("198.51.100.77", 40000))
    response = register(other_ip, "  " + new.upper() + " ")
    assert response.status_code == 429 and 1 <= int(response.headers["retry-after"]) <= 3600


def test_a_registration_that_sends_no_mail_does_not_count(make_app, make_client, quick_user):
    app = make_app(limits={"register_account": Limit(1, 3600)})
    taken = quick_user().handle
    client = make_client(app)
    email = f"{unique()}@example.org"
    for _ in range(3):
        response = register(client, email, taken)
        assert response.status_code == 409 and response.json()["error"] == "handle_taken"
    assert register(client, email).status_code == 202
    assert register(client, email).status_code == 429


def test_rate_key():
    from app.security import rate_key

    assert rate_key("203.0.113.5") == "203.0.113.5"
    assert rate_key("::ffff:203.0.113.5") == "203.0.113.5"
    assert rate_key("2001:db8:a:b:1:2:3:4") == "2001:db8:a:b::/64"
    assert rate_key("2001:DB8:A:B::1") == "2001:db8:a:b::/64"
    assert rate_key("fe80::1%eth0") == "fe80::/64"
    assert rate_key("unknown") == "unknown"


def _login(client, **kwargs):
    return client.post("/api/auth/login", json={"email": f"{unique()}@example.org", "password": "x" * 12}, **kwargs)


# Every route with a limit per IP, with the bucket that it counts in.
PER_IP = {
    "login": ("login_ip", _login),
    "confirm": ("login_ip", lambda c, **kw: c.post("/api/auth/confirm", json={"token": "made-up", "password": "x" * 12},
                                                   **kw)),
    "register": ("register_ip", lambda c, **kw: register(c, f"{unique()}@example.org", **kw)),
    "reset-request": ("reset_ip", lambda c, **kw: c.post("/api/auth/reset-request",
                                                         json={"email": f"{unique()}@example.org"}, **kw)),
    "reset": ("reset_ip", lambda c, **kw: c.post("/api/auth/reset", json={"token": "made-up", "password": "x" * 12},
                                                 **kw)),
    "password-check": ("password_check_ip", lambda c, **kw: c.post("/api/auth/password-check",
                                                                   json={"password": "x" * 12}, **kw)),
}


@pytest.mark.parametrize("route", PER_IP)
def test_ipv6_clients_of_one_64_network_share_a_bucket(route, make_app, make_client):
    """One host often owns a whole IPv6 /64 network. Two addresses of one /64 count in one bucket, behind the proxy and
    without it. An address of another /64 has its own bucket, and IPv4 clients still count by their address."""
    bucket, call = PER_IP[route]
    app = make_app(limits={bucket: Limit(2, 3600)}, trusted_proxies=PROXY)
    proxy = make_client(app, client=("10.0.0.2", 40000))

    def via(ip):
        return call(proxy, headers={"X-Forwarded-For": ip}).status_code

    assert via("2001:db8:a:b::1") != 429
    assert via("2001:db8:a:b:ffff:ffff:ffff:ffff") != 429
    assert via("2001:db8:a:b:1234::5") == 429
    assert via("2001:db8:a:c::1") != 429
    assert via("203.0.113.5") != 429 and via("203.0.113.5") != 429 and via("203.0.113.5") == 429
    assert via("203.0.113.6") != 429
    # Without a proxy, the address of the connection counts in the same way.
    direct = [call(make_client(app, client=(ip, 40000))).status_code
              for ip in ("2001:db8:d:e::1", "2001:db8:d:e::2", "2001:db8:d:e::3", "2001:db8:d:f::1")]
    assert [status == 429 for status in direct] == [False, False, True, False]
