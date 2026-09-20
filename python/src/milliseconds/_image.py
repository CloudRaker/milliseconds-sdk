"""One image per call: bytes, a path, a data URL or bare base64.

The API never fetches a URL, and it refuses anything over 5 MB. Both checks run
here, before the call, so nothing is billed for an image the API would reject.
"""

from __future__ import annotations

import base64
import os
import re
from pathlib import Path
from typing import Any, cast

from ._errors import client_error

MAX_BYTES = 5 * 1024 * 1024
# The base64 length of MAX_BYTES. Checked before any decode, as the API does.
MAX_BASE64 = -(-MAX_BYTES * 4 // 3)

_DATA_URL = re.compile(r"^data:image/(jpeg|png|webp);base64,")
# The base64 of the first bytes of a JPEG, a PNG and a WebP.
_MAGIC = ("/9j/", "iVBORw0", "UklGR")

DETAILS = ("low", "medium", "high")

_TOO_LARGE = "The image is over the 5 MB limit. Resize it, or send a smaller crop."
_NOT_IMAGE = (
    "The image must be a data:image/(jpeg|png|webp);base64,... URL, the bare base64 of a "
    "JPEG, PNG or WebP, the bytes themselves, or a pathlib.Path to the file."
)
_NO_URL = "The API never fetches a URL. Read the bytes yourself and send them."


def encode(image: Any) -> str:
    """The wire value: a data URL or bare base64."""
    if isinstance(image, (bytes, bytearray)):
        return _from_bytes(bytes(image))
    if isinstance(image, os.PathLike):
        return _from_bytes(Path(os.fspath(cast("os.PathLike[str]", image))).read_bytes())
    if isinstance(image, str):
        return _check(image)
    raise client_error(_NOT_IMAGE)


def detail(value: Any) -> str:
    if value not in DETAILS:
        raise client_error(f"detail takes {', '.join(DETAILS)}, not {value!r}.")
    return value


def _from_bytes(raw: bytes) -> str:
    if len(raw) > MAX_BYTES:
        raise client_error(_TOO_LARGE)
    return _check(base64.b64encode(raw).decode("ascii"))


def _check(image: str) -> str:
    if image[:8].lower().startswith(("http://", "https:/")):
        raise client_error(_NO_URL)
    body = image
    if image.startswith("data:"):
        match = _DATA_URL.match(image)
        if match is None:
            raise client_error(_NOT_IMAGE)
        body = image[match.end() :]
    if len(body) > MAX_BASE64:
        raise client_error(_TOO_LARGE)
    if not body.startswith(_MAGIC):
        raise client_error(_NOT_IMAGE)
    return image
