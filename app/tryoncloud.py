"""Server-side TryOnCloud Developer API client.

Never expose the key to the browser. The Developer API accepts two images
and returns a finished PNG. Platform /api/v1/tryon is a different, invite-only API.
"""

from __future__ import annotations

import json
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

GENERATE_URL = "https://www.tryoncloud.com/api/v1/generate"
TIMEOUT_SEC = 60
MAX_IMAGE_BYTES = 15 * 1024 * 1024


class TryOnCloudError(Exception):
    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def _part(boundary: str, name: str, filename: str, data: bytes, content_type: str) -> bytes:
    header = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    return header + data + b"\r\n"


def generate_tryon(
    api_key: str,
    person_image: bytes,
    garment_image: bytes,
    person_filename: str = "person.jpg",
    garment_filename: str = "garment.png",
) -> bytes:
    if not api_key:
        raise TryOnCloudError("TryOnCloud açarı serverdə yoxdur.", 503)
    if not person_image or not garment_image:
        raise TryOnCloudError("Şəkil boşdur.", 400)
    if len(person_image) > MAX_IMAGE_BYTES or len(garment_image) > MAX_IMAGE_BYTES:
        raise TryOnCloudError("Şəkil 15 MB-dan böyük ola bilməz.", 413)

    boundary = f"----TryOn{uuid.uuid4().hex}"
    body = (
        _part(boundary, "person_image", person_filename, person_image, "application/octet-stream")
        + _part(
            boundary,
            "garment_image",
            garment_filename,
            garment_image,
            "application/octet-stream",
        )
        + f"--{boundary}--\r\n".encode("utf-8")
    )
    req = Request(
        GENERATE_URL,
        data=body,
        method="POST",
        headers={
            "X-API-KEY": api_key,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    try:
        with urlopen(req, timeout=TIMEOUT_SEC) as resp:
            payload = resp.read()
            content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
    except HTTPError as exc:
        raw = exc.read() if exc.fp else b""
        message = _error_message(raw, exc.code)
        raise TryOnCloudError(message, 402 if exc.code == 402 else 502) from exc
    except URLError as exc:
        raise TryOnCloudError("TryOnCloud-a qoşulmaq mümkün olmadı.", 502) from exc

    if content_type.startswith("image/"):
        return payload
    if payload[:8] == b"\x89PNG\r\n\x1a\n" or payload[:3] == b"\xff\xd8\xff":
        return payload
    raise TryOnCloudError(_error_message(payload, 502), 502)


def _error_message(raw: bytes, status: int) -> str:
    try:
        data = json.loads(raw.decode("utf-8"))
        code = str(data.get("code") or "")
        if code in {"NO_CREDITS", "FREE_TRIAL_USED"} or status == 402:
            return "Pulsuz try-on limiti bitib. TryOnCloud-da kredit əlavə edin."
        if code in {"NO_KEY", "INVALID_KEY"} or status == 401:
            return "TryOnCloud açarı yanlışdır."
        if data.get("error"):
            return str(data["error"])
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        pass
    if status == 429:
        return "TryOnCloud limiti doldu. Bir az sonra yenidən cəhd edin."
    return "Virtual try-on hazırlanmadı. Başqa şəkil yoxlayın."
