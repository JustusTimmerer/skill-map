"""Errors of the API. Every error body is {"error": "<code>", "message": "<English text>", "params": {...}}.

The text of a code is error.<code> in the catalog errors.json (texts.py). A code with several texts names its text with
a variant: error.<code>.<variant>, and params.variant names it. params holds every value that the text needs. message
is the English text with these values. A page shows the text of the code in its own language (i18n/README.md).

Each error names its code and its variant as literal strings, for example ApiError(409, 'handle_taken') or
bad('weak_password', 'short', min=12) in double quotes, so that npm run check:texts finds the key of each one."""
from __future__ import annotations

from . import texts


class ApiError(Exception):
    def __init__(self, status: int, code: str, variant: str | None = None, /, *, headers: dict | None = None, **values):
        super().__init__(code)
        self.status = status
        self.code = code
        self.key = f"error.{code}.{variant}" if variant else f"error.{code}"
        self.values = values
        self.params = {**values, "variant": variant} if variant else dict(values)
        self.message = texts.text(texts.SOURCE, self.key, **values)
        self.headers = headers or {}

    def body(self) -> dict:
        return {"error": self.code, "message": self.message, "params": self.params}


def not_found() -> ApiError:
    return ApiError(404, "not_found")


def not_logged_in() -> ApiError:
    return ApiError(401, "not_logged_in")


def bad(code: str, variant: str | None = None, /, **values) -> ApiError:
    return ApiError(400, code, variant, **values)
