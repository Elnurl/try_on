"""Request authentication: admin password, store API keys, seller upload tokens."""

from __future__ import annotations

import hmac
import logging
import os

from fastapi import HTTPException, Request

from app.storage import read_upload_token, store_for_key

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

if not ADMIN_PASSWORD:
    logging.getLogger("vto").warning("ADMIN_PASSWORD təyin olunmayıb — admin API qorunmur (yalnız lokal dev).")


def require_admin(request: Request) -> None:
    if not ADMIN_PASSWORD:
        return
    given = request.headers.get("x-admin-password", "")
    if not given or not hmac.compare_digest(given, ADMIN_PASSWORD):
        raise HTTPException(status_code=401, detail="Admin parolu yanlışdır.")


def _bearer(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


def caller(request: Request) -> dict:
    """{store, seller}; seller is None for full store keys, a string for upload tokens."""
    key = request.headers.get("x-api-key", "") or _bearer(request)
    if key:
        store = store_for_key(key)
        if store:
            return {"store": store, "seller": None}
        raise HTTPException(status_code=401, detail="API açarı yanlışdır.")
    token = request.headers.get("x-upload-token", "") or request.query_params.get("token", "")
    if token:
        data = read_upload_token(token)
        if data:
            return data
        raise HTTPException(status_code=401, detail="Yükləmə linkinin vaxtı bitib və ya yanlışdır.")
    raise HTTPException(status_code=401, detail="API açarı və ya yükləmə tokeni lazımdır.")
