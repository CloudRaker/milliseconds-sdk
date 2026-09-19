"""Headers, retries, error parsing and header parsing.

Both clients import this module, so the two cannot drift.
"""

from __future__ import annotations

import importlib.metadata
import random
from collections.abc import Mapping
from typing import Any

import httpx

from ._errors import MillisecondsError, make_error
from ._models import RateLimit, Usage

MODEL = "decision-machine-1"
DEFAULT_BASE_URL = "https://api.milliseconds.ai"


def _version() -> str:
    """One source of truth: the installed metadata, which pyproject.toml writes."""
    try:
        return importlib.metadata.version("cloudraker-milliseconds")
    except importlib.metadata.PackageNotFoundError:  # a source tree nobody installed
        return "0.0.0"


VERSION = _version()
USER_AGENT = f"cloudraker-milliseconds-python/{VERSION}"

MAX_RETRY_AFTER = 60.0
MAX_BACKOFF = 8.0

# The fallback when the body is not the worker's JSON envelope: a Cloudflare edge page.
# The retryable statuses keep their retryable code, so the retry policy stays on.
_STATUS_CODE = {
    400: "invalid_request",
    401: "invalid_api_key",
    429: "rate_limit_exceeded",
    500: "internal_error",
    502: "runner_error",
    529: "overloaded",
}

_RATE_LIMIT_HEADERS = (
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
)


def headers(api_key: str, *layers: Mapping[str, str] | None) -> dict[str, str]:
    """Merge the header layers over the SDK defaults. `authorization` always wins.

    A header name is case insensitive on the wire, so every layer is lowercased
    first. Without that, a caller's `Authorization` travels as a second header line
    and Cloudflare answers 400. `content-type` and `user-agent` are defaults a
    caller may replace, as in the TypeScript SDK.
    """
    out: dict[str, str] = {"content-type": "application/json", "user-agent": USER_AGENT}
    for layer in layers:
        if layer:
            out.update({k.lower(): v for k, v in layer.items()})
    out["authorization"] = f"Bearer {api_key}"
    return out


def _int(value: str | None) -> int:
    try:
        return int(value or 0)
    except ValueError:
        return 0


def parse_rate_limit(h: httpx.Headers) -> RateLimit | None:
    """The six values are written together, or not at all."""
    if any(name not in h for name in _RATE_LIMIT_HEADERS):
        return None
    return RateLimit(
        limit_requests=_int(h.get("x-ratelimit-limit-requests")),
        remaining_requests=_int(h.get("x-ratelimit-remaining-requests")),
        reset_requests=h.get("x-ratelimit-reset-requests", ""),
        limit_tokens=_int(h.get("x-ratelimit-limit-tokens")),
        remaining_tokens=_int(h.get("x-ratelimit-remaining-tokens")),
        reset_tokens=h.get("x-ratelimit-reset-tokens", ""),
    )


def parse_usage(h: httpx.Headers) -> Usage:
    return Usage(
        input_chars=_int(h.get("x-input-chars")),
        input_tokens=_int(h.get("x-input-tokens")),
        inference_ms=_int(h.get("x-inference-ms")),
        rate_limit=parse_rate_limit(h),
        headers=dict(h),
    )


def _retry_after(h: httpx.Headers) -> float | None:
    """Only 429 rate_limit_exceeded carries it."""
    raw = h.get("retry-after")
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def decode(response: httpx.Response) -> tuple[Any, Usage]:
    """Read a 2xx reply. A body the SDK cannot read raises, it never leaks a json error."""
    try:
        return response.json(), parse_usage(response.headers)
    except Exception as exc:  # noqa: BLE001 - any decode failure is one SDK error
        raise make_error(
            "internal_error",
            f"milliseconds sent a {response.status_code} the SDK could not read: {exc}",
            status=response.status_code,
            response=response,
        ) from exc


def error_for(response: httpx.Response, attempts: int, elapsed: float) -> MillisecondsError:
    status = response.status_code
    code = _STATUS_CODE.get(status) or ("internal_error" if status >= 500 else "http_error")
    message = response.text[:500]
    try:
        body: Any = response.json()
        err = body["error"]
        code = str(err["code"])
        message = str(err["message"])
    except Exception:  # noqa: BLE001 - a non-JSON body still has to raise the right class
        pass
    return make_error(
        code,
        message,
        status=response.status_code,
        retry_after=_retry_after(response.headers),
        rate_limit=parse_rate_limit(response.headers),
        response=response,
        attempts=attempts,
        elapsed=elapsed,
    )


def error_for_exc(exc: Exception, attempts: int, elapsed: float) -> MillisecondsError:
    code = "timeout" if isinstance(exc, httpx.TimeoutException) else "connection_error"
    return make_error(code, str(exc) or type(exc).__name__, attempts=attempts, elapsed=elapsed)


def retry_delay(err: MillisecondsError, attempt: int, max_retries: int) -> float | None:
    """Seconds to wait before attempt `attempt + 1`, or None to raise `err`.

    Every capability is a pure function, so a retry is always safe. A 400, a 401
    and a spent quota are never retried: a timer retry cannot fix them.
    """
    if not err.retryable or attempt > max_retries:
        return None
    if err.code == "rate_limit_exceeded" and err.retry_after is not None:
        return min(err.retry_after, MAX_RETRY_AFTER)
    return random.random() * min(0.5 * 2 ** (attempt - 1), MAX_BACKOFF)  # full jitter
