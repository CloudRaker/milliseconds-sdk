"""One exception tree. Catch a subclass, or read `code`."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ._models import RateLimit

if TYPE_CHECKING:
    import httpx

__all__ = [
    "AuthenticationError",
    "ConnectionError",
    "InvalidRequestError",
    "MillisecondsError",
    "OverloadedError",
    "QuotaExceededError",
    "RateLimitError",
    "RunnerError",
]

RETRYABLE = frozenset(
    {"rate_limit_exceeded", "runner_error", "overloaded", "connection_error", "timeout"}
)

CONSOLE = "https://console.milliseconds.ai"

_HEADLINE = {
    "invalid_request": "milliseconds rejected the request (400 invalid_request)",
    "invalid_schema": "milliseconds rejected the schema (400 invalid_schema)",
    "missing_api_key": "milliseconds got no API key (401 missing_api_key)",
    "invalid_api_key": "milliseconds rejected the API key (401 invalid_api_key)",
    "rate_limit_exceeded": "rate limited (429 rate_limit_exceeded)",
    "insufficient_quota": "no token credits left (429 insufficient_quota)",
    "runner_error": "inference failed (502 runner_error)",
    "overloaded": "every inference slot stayed busy (529 overloaded)",
    "internal_error": "milliseconds failed (500 internal_error)",
    "connection_error": "could not reach milliseconds (connection_error)",
    "timeout": "the request timed out (timeout)",
}

_KEY_HINT = 'Keys start with "sk-ms-". Check MS_API_KEY, or create a key at ' + CONSOLE + "."

_HINT = {
    "invalid_request": "Check the body against https://docs.milliseconds.ai.",
    "invalid_schema": (
        "The schema must be an object with properties. Strings, numbers, booleans, "
        "enums, arrays of strings and nested objects are supported."
    ),
    "missing_api_key": _KEY_HINT,
    "invalid_api_key": _KEY_HINT,
    "rate_limit_exceeded": (
        "Lower your concurrency, or raise max_retries. Limits are per organization "
        "and shared by every key."
    ),
    "insufficient_quota": "Not retried. A timer retry will not help.",
    "runner_error": "Inference failed twice on the server. The SDK already retried.",
    "overloaded": (
        "This is backpressure, not a fault. Send fewer texts per call, or back off "
        "further. A texts batch of 32 asks for 32 slots at once."
    ),
    "connection_error": (
        "Check base_url and the network. max_retries=0 turns the retries off and "
        "shows the first failure."
    ),
    "timeout": "Raise timeout, or send fewer texts per call.",
}

# The API message already names the labels rule; this hint says what to do about it.
_LABELS_HINT = (
    "classify needs two or more labels. Describe each one. Described labels score "
    "measurably better than bare names."
)

# The codes whose own message adds nothing a caller can act on.
_QUIET = frozenset({"missing_api_key", "invalid_api_key", "overloaded"})


def _message(code: str, status: int | None, api_message: str, attempts: int, elapsed: float) -> str:
    if code == "client_error":
        return api_message
    head = _HEADLINE.get(code) or f"milliseconds returned an error ({status} {code})"
    if attempts > 1:
        head += f" after {attempts} attempts over {elapsed:.1f}s"
    hint = _HINT.get(code, "")
    # ponytail: one prefix test, not a table of API messages. Add a row when a second
    # 400 earns its own hint.
    if code == "invalid_request" and api_message.startswith("labels:"):
        hint = _LABELS_HINT
    head += "." if code in _QUIET or not api_message else f":\n{api_message}"
    return f"{head}\n  {hint}" if hint else head


class MillisecondsError(Exception):
    """Every SDK failure. `code` is the wire code, or a code the SDK raised itself."""

    def __init__(
        self,
        code: str,
        api_message: str,
        *,
        status: int | None = None,
        retry_after: float | None = None,
        rate_limit: RateLimit | None = None,
        response: httpx.Response | None = None,
        attempts: int = 1,
        elapsed: float = 0.0,
    ) -> None:
        super().__init__(_message(code, status, api_message, attempts, elapsed))
        self.code = code
        self.status = status
        self.api_message = api_message
        self.retry_after = retry_after
        self.rate_limit = rate_limit
        self.response = response
        self.attempts = attempts
        self.retryable = code in RETRYABLE


class InvalidRequestError(MillisecondsError):
    """400 invalid_request, 400 invalid_schema, and every client-side check."""


class AuthenticationError(MillisecondsError):
    """401."""


class RateLimitError(MillisecondsError):
    """429 rate_limit_exceeded."""


class QuotaExceededError(MillisecondsError):
    """429 insufficient_quota. Never retried."""


class RunnerError(MillisecondsError):
    """502."""


class OverloadedError(MillisecondsError):
    """529."""


class ConnectionError(MillisecondsError):  # noqa: A001 - shadows the builtin inside this package only
    """No response: a transport failure or a timeout."""


_CLASS = {
    "invalid_request": InvalidRequestError,
    "invalid_schema": InvalidRequestError,
    "client_error": InvalidRequestError,
    "missing_api_key": AuthenticationError,
    "invalid_api_key": AuthenticationError,
    "rate_limit_exceeded": RateLimitError,
    "insufficient_quota": QuotaExceededError,
    "runner_error": RunnerError,
    "overloaded": OverloadedError,
    "connection_error": ConnectionError,
    "timeout": ConnectionError,
}


def make_error(
    code: str,
    api_message: str,
    *,
    status: int | None = None,
    retry_after: float | None = None,
    rate_limit: RateLimit | None = None,
    response: httpx.Response | None = None,
    attempts: int = 1,
    elapsed: float = 0.0,
) -> MillisecondsError:
    cls = _CLASS.get(code, MillisecondsError)
    return cls(
        code,
        api_message,
        status=status,
        retry_after=retry_after,
        rate_limit=rate_limit,
        response=response,
        attempts=attempts,
        elapsed=elapsed,
    )


def client_error(message: str) -> InvalidRequestError:
    """A check that failed before any HTTP call. Nothing was sent, nothing was billed."""
    return InvalidRequestError("client_error", message, status=0)
