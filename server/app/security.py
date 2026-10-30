"""Passwords, handles, e-mail addresses, random tokens and the client IP."""
from __future__ import annotations

import hashlib
import ipaddress
import re
import secrets
import unicodedata
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from . import strength
from .errors import ApiError, bad

# Argon2id with a random salt per hash (the defaults of argon2-cffi: 3 passes, 64 MiB, 4 lanes).
_hasher = PasswordHasher()

PASSWORD_MIN = 12
PASSWORD_MAX = 1024
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")
# A local part, "@" and a domain with at least one dot. A mail header reads "," and ";" as the end of an address, and
# <, >, (, ), [, ], \ and " as quotes or comments. So an address holds none of them, no white space and no control
# character, and it always names exactly one mailbox.
EMAIL_RE = re.compile(r'^[^@\s,;<>()\[\]\\"\x00-\x1f\x7f]{1,64}@[^@\s.,;<>()\[\]\\"\x00-\x1f\x7f]+'
                      r'(\.[^@\s.,;<>()\[\]\\"\x00-\x1f\x7f]+)+$')

# Names that are not free as a handle, because a handle is also a subdomain and a top-level path: <BASE_URL>/<handle>.
# Every top-level name of the site and of the app is here: build_selfhost.js stops the build if one is missing.
RESERVED = frozenset("""
    www api app mail admin static assets u s embed konto account accounts login logout register signup
    settings help support docs status blog about impressum datenschutz privacy terms agb kontakt contact
    root system it-skills itskills smtp imap pop pop3 ftp sftp ssh ns ns1 ns2 dns mx cdn dev test staging
    demo public shared share user users new edit webmail autoconfig
    autodiscover postmaster hostmaster abuse noreply no-reply security
    vendor index example map server-map imprint ai llms license
""".split())

def normalize_password(password: str) -> str:
    # The same password typed on two devices can arrive in two Unicode forms; NFKC makes them equal.
    return unicodedata.normalize("NFKC", password)


def hash_password(password: str) -> str:
    return _hasher.hash(normalize_password(password))


def verify_password(stored_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(stored_hash, normalize_password(password))
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(stored_hash)
    except InvalidHashError:
        return True


# A login with an unknown e-mail verifies against this hash, so that it takes as long as a real one.
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def password_verdict(password: str, email: str = "", handle: str = "") -> dict:
    """{problem, score, warning, tips}: the variant of weak_password or None, and the rating of strength.rate. The rule
    of each new password and the strength meter of the account page both use it, so that they always agree."""
    password = normalize_password(password)
    if len(password) < PASSWORD_MIN:
        return {"problem": "short", "score": 0, "warning": None, "tips": []}
    if len(password) > PASSWORD_MAX:
        return {"problem": "long", "score": 0, "warning": None, "tips": []}
    email, handle = email.lower(), handle.lower()
    personal = [word for word in (email, email.split("@")[0], handle) if word]
    if password.lower() in personal:
        return {"problem": "personal", "score": 0, "warning": "personal", "tips": []}
    rating = strength.rate(password, personal)
    return {"problem": None if rating["score"] >= strength.STRONG else "guessable", **rating}


def password_problem(password: str, email: str = "", handle: str = "") -> ApiError | None:
    """The error weak_password, with the variant that says why the password is not allowed, or None."""
    problem = password_verdict(password, email, handle)["problem"]
    if problem == "short":
        return bad("weak_password", "short", min=PASSWORD_MIN)
    if problem == "long":
        return bad("weak_password", "long", max=PASSWORD_MAX)
    if problem == "personal":
        return bad("weak_password", "personal")
    if problem == "guessable":
        return bad("weak_password", "guessable")
    return None


def handle_problem(handle: str) -> ApiError | None:
    """The error if the handle is not allowed, else None."""
    if not HANDLE_RE.match(handle) or "--" in handle:
        return bad("invalid_handle")
    if handle in RESERVED:
        return bad("reserved_handle")
    return None


def normalize_email(email: str) -> str | None:
    email = (email or "").strip().lower()
    if len(email) > 254 or not EMAIL_RE.match(email):
        return None
    return email


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


def hash_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def rate_key(ip: str) -> str:
    """The key of a client in every rate limit per IP. One host often owns a whole IPv6 /64 network and can take a new
    address in it for each request, so an IPv6 client counts by its /64. An IPv4 client counts by its address, also when
    it arrives as an IPv4-mapped IPv6 address such as ::ffff:203.0.113.5."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if address.version == 6:
        if address.ipv4_mapped:
            return str(address.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(address) >> 64 << 64, 64)))
    return str(address)


def client_ip(peer: str | None, forwarded_for: str | None, trusted: tuple) -> str:
    """The IP of the client. X-Forwarded-For counts only when the direct peer is a trusted proxy; then the
    rightmost address that is not a trusted proxy is the client."""
    try:
        ip = ipaddress.ip_address(peer or "")
    except ValueError:
        return peer or "unknown"

    def is_trusted(address) -> bool:
        return any(address in network for network in trusted)

    if not forwarded_for or not is_trusted(ip):
        return str(ip)
    for hop in reversed([part.strip() for part in forwarded_for.split(",")]):
        try:
            hop_ip = ipaddress.ip_address(hop)
        except ValueError:
            break
        if not is_trusted(hop_ip):
            return str(hop_ip)
        ip = hop_ip
    return str(ip)
