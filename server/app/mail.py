"""E-mail over SMTP. Locally the mails go to mailpit; on a server to the SMTP server in SMTP_HOST.

Each mail goes out in the language of its recipient (server/README.md, "The languages"). Its subject and its text are
the texts mail.* of the catalog mail.json (texts.py)."""
from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from .config import Settings
from . import texts
from .util import one_line

log = logging.getLogger("skill-map.mail")


def build_message(settings: Settings, to: str, subject: str, text: str) -> EmailMessage:
    """The mail. Its subject is one line: a line break or a hidden character of a name, such as U+2028, becomes a space,
    because a header with a line break makes the mail fail."""
    message = EmailMessage()
    message["From"] = settings.mail_from
    message["To"] = to
    message["Subject"] = one_line(subject)
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid(domain=settings.host or None)
    message.set_content(text)
    return message


def send(settings: Settings, to: str, subject: str, text: str) -> None:
    """Sends one mail. With SMTP_SECURITY starttls, a server without STARTTLS stops the mail (SMTPNotSupportedError):
    there is no fall back to plain text. The app logs in to the mail server only inside TLS. Settings refuses SMTP_USER
    with SMTP_SECURITY none at the start, and this function checks the connection again before each login."""
    message = build_message(settings, to, subject, text)
    context = ssl.create_default_context()
    if settings.smtp_security == "tls":
        server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=20, context=context)
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20)
    with server:
        if settings.smtp_security == "starttls":
            server.starttls(context=context)
        if settings.smtp_user:
            if not isinstance(server.sock, ssl.SSLSocket):
                raise smtplib.SMTPException("no login to the mail server without TLS: the password would go in plain text")
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(message)


def send_quietly(settings: Settings, to: str, subject: str, text: str) -> None:
    """Runs after the response is sent; a failure goes to the log, never to the client."""
    try:
        send(settings, to, subject, text)
    except Exception:  # noqa: BLE001 - the client must not learn about mail problems
        log.exception("could not send the mail %r", subject)


def confirm_mail(settings: Settings, language: str, handle: str, token: str, hours: int) -> tuple[str, str]:
    """The mail after a registration, in the language of the registration."""
    return (
        texts.text(language, "mail.confirm.subject", host=settings.host),
        texts.text(language, "mail.confirm.body", handle=handle, link=f"{settings.base_url}/account#confirm={token}",
                   validity=texts.text(language, "mail.confirm.validity", count=hours)),
    )


def already_registered_mail(settings: Settings, language: str) -> tuple[str, str]:
    """The mail to an address that has an account, in the language of the account."""
    return (
        texts.text(language, "mail.registered.subject", host=settings.host),
        texts.text(language, "mail.registered.body", link=f"{settings.base_url}/account"),
    )


def role_label(language: str, role: str) -> str:
    """The name of a team role in a mail."""
    return {
        "owner": texts.text(language, "mail.role.owner"),
        "editor": texts.text(language, "mail.role.editor"),
        "reader": texts.text(language, "mail.role.reader"),
    }[role]


def invite_mail(settings: Settings, language: str, inviter: str, team_name: str, team_handle: str, role: str,
                token: str, days: int) -> tuple[str, str]:
    """An invitation, in the language of the account of the address, else in the language of the person who invites."""
    return (
        texts.text(language, "mail.invitation.subject", team=team_name, host=settings.host),
        texts.text(language, "mail.invitation.body", inviter=inviter, team=team_name, handle=team_handle,
                   role=role_label(language, role), link=f"{settings.base_url}/account#invite={token}",
                   validity=texts.text(language, "mail.invitation.validity", count=days)),
    )


def reset_mail(settings: Settings, language: str, handle: str, token: str) -> tuple[str, str]:
    """The mail with the link for a new password, in the language of the account."""
    return (
        texts.text(language, "mail.reset.subject", host=settings.host),
        texts.text(language, "mail.reset.body", handle=handle, link=f"{settings.base_url}/account#reset={token}"),
    )
