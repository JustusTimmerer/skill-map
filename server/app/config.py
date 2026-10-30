"""Settings of the app. Every value comes from an environment variable (see server/README.md)."""
from __future__ import annotations

import ipaddress
import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

# Rate limits as "count/seconds": at most count requests in a window of that many seconds.
DEFAULT_LIMITS = {
    "login_ip": "20/900",
    "login_account": "10/900",
    "register_ip": "10/3600",
    "register_account": "3/3600",
    "reset_ip": "10/3600",
    "reset_account": "3/3600",
    "invite_user": "20/3600",
    "invite_email": "3/3600",
    "password_check_ip": "600/600",
}


@dataclass(frozen=True)
class Limit:
    count: int
    seconds: int

    @classmethod
    def parse(cls, text: str) -> "Limit":
        match = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", text or "")
        if not match or int(match[1]) < 1 or int(match[2]) < 1:
            raise ValueError(f"a rate limit looks like 10/900 (count/seconds), not {text!r}")
        return cls(int(match[1]), int(match[2]))


def _limits(values: dict[str, str]) -> dict[str, Limit]:
    return {name: Limit.parse(text) for name, text in values.items()}


def _networks(text: str) -> tuple:
    return tuple(ipaddress.ip_network(part.strip(), strict=False) for part in (text or "").split(",") if part.strip())


@dataclass(frozen=True)
class Settings:
    base_url: str
    database_url: str = ""
    base_domain: str = ""
    local: bool = False
    trusted_proxies: tuple = ()
    smtp_host: str = "localhost"
    smtp_port: int = 25
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_security: str = "none"
    mail_from: str = ""
    session_days: int = 30
    session_idle_days: int = 7
    limits: dict = field(default_factory=lambda: _limits(DEFAULT_LIMITS))
    page_file: str = "/srv/site/server-map.html"
    start_file: str = "/srv/site/index.html"
    pool_min: int = 1
    pool_max: int = 10
    max_maps: int = 50
    max_teams: int = 20
    handle_hold_days: int = 180
    run_migrations: bool = True

    def __post_init__(self):
        parts = urlsplit(self.base_url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.path not in ("", "/") or parts.query:
            raise ValueError(f"BASE_URL must look like https://example.org, not {self.base_url!r}")
        # The Origin header of a browser has no default port, so the base URL drops it too.
        default_port = {"https": 443, "http": 80}[parts.scheme]
        port = f":{parts.port}" if parts.port and parts.port != default_port else ""
        object.__setattr__(self, "base_url", f"{parts.scheme}://{parts.hostname}{port}".lower())
        object.__setattr__(self, "base_domain", self.base_domain.strip().strip(".").lower())
        if self.handle_hold_days < 0:
            raise ValueError("HANDLE_HOLD_DAYS must be 0 or more")
        if self.smtp_security not in ("none", "starttls", "tls"):
            raise ValueError("SMTP_SECURITY must be none, starttls or tls")
        if self.smtp_user and self.smtp_security == "none":
            # The app would send the password of the mail server in plain text, so it does not start.
            raise ValueError("SMTP_USER is set, but SMTP_SECURITY is none: the app would send the SMTP password in plain"
                             " text. Set SMTP_SECURITY to starttls or tls, or leave SMTP_USER empty.")
        if self.session_days < 1 or self.session_idle_days < 1:
            raise ValueError("SESSION_DAYS and SESSION_IDLE_DAYS must be 1 or more")
        if not self.mail_from:
            object.__setattr__(self, "mail_from", f"it-skills <no-reply@{parts.hostname}>")
        missing = set(DEFAULT_LIMITS) - set(self.limits)
        if missing:
            object.__setattr__(self, "limits", {**_limits({k: DEFAULT_LIMITS[k] for k in missing}), **self.limits})

    @property
    def origin(self) -> str:
        """The value that the Origin header of a write must have."""
        return self.base_url

    @property
    def host(self) -> str:
        return urlsplit(self.base_url).hostname or ""

    def owner_url(self, handle: str) -> str:
        """The address of an owner (a user or a team): its start map, or the list of its public maps (pages.py)."""
        return f"{self.base_url}/{handle}"

    def map_url(self, handle: str, slug: str) -> str:
        """The address of a map: <BASE_URL>/<handle>/<slug>."""
        return f"{self.base_url}/{handle}/{slug}"

    def site_url(self, handle: str) -> str | None:
        """The base URL of the subdomain of a handle, or None without BASE_DOMAIN. The subdomains are an option of the
        host. The path addresses of owner_url() and map_url() always work."""
        if not self.base_domain:
            return None
        parts = urlsplit(self.base_url)
        port = f":{parts.port}" if parts.port else ""
        return f"{parts.scheme}://{handle}.{self.base_domain}{port}"

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Settings":
        env = os.environ if env is None else env
        get = lambda name, default="": env.get(name, default).strip()  # noqa: E731
        base_url = get("BASE_URL")
        if not base_url:
            raise ValueError("BASE_URL is not set")
        limits = {name: get("RATE_LIMIT_" + name.upper(), text) for name, text in DEFAULT_LIMITS.items()}
        return cls(
            base_url=base_url,
            database_url=get("DATABASE_URL"),
            base_domain=get("BASE_DOMAIN"),
            local=get("APP_ENV", "production").lower() == "local",
            trusted_proxies=_networks(get("TRUSTED_PROXIES")),
            smtp_host=get("SMTP_HOST", "localhost"),
            smtp_port=int(get("SMTP_PORT", "25")),
            smtp_user=get("SMTP_USER"),
            smtp_password=env.get("SMTP_PASSWORD", ""),
            smtp_security=get("SMTP_SECURITY", "none").lower(),
            mail_from=get("MAIL_FROM"),
            session_days=int(get("SESSION_DAYS", "30")),
            session_idle_days=int(get("SESSION_IDLE_DAYS", "7")),
            limits=_limits(limits),
            page_file=get("PAGE_FILE", "/srv/site/server-map.html"),
            start_file=get("START_FILE", "/srv/site/index.html"),
            pool_min=int(get("DB_POOL_MIN", "1")),
            pool_max=int(get("DB_POOL_MAX", "10")),
            max_maps=int(get("MAX_MAPS_PER_OWNER", "50")),
            max_teams=int(get("MAX_TEAMS_PER_USER", "20")),
            handle_hold_days=int(get("HANDLE_HOLD_DAYS", "180")),
            run_migrations=get("RUN_MIGRATIONS", "1") not in ("0", "false", "no"),
        )
