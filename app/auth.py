"""Single-admin session auth.

Production: set ADMIN_PASSWORD env var → /admin routes require login.
Local dev: leave it unset → admin panels open without login (a warning is logged).
Session cookie is an HMAC of a per-process random secret, so restarting the
server invalidates old sessions — acceptable for a single-admin MVP.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets
from hashlib import sha256

from fastapi import Request

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
COOKIE_NAME = "vto_admin"
_SESSION_SECRET = secrets.token_bytes(32)

if not ADMIN_PASSWORD:
    logging.getLogger("tryon").warning(
        "ADMIN_PASSWORD təyin olunmayıb — admin panel qorunmur (yalnız lokal dev üçün)."
    )


def auth_enabled() -> bool:
    return bool(ADMIN_PASSWORD)


def session_token() -> str:
    return hmac.new(_SESSION_SECRET, b"admin-session", sha256).hexdigest()


def check_password(password: str) -> bool:
    return auth_enabled() and hmac.compare_digest(password, ADMIN_PASSWORD)


def is_authed(request: Request) -> bool:
    if not auth_enabled():
        return True
    return hmac.compare_digest(request.cookies.get(COOKIE_NAME, ""), session_token())
