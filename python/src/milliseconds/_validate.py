"""The client-side checks. They run before any HTTP call, so nothing is billed.

Each one rejects locally what the server rejects, plus two documented API traps.
Every failure raises InvalidRequestError with code `client_error` and status 0.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast

from ._errors import client_error

MAX_TEXTS = 32
MAX_CHARS = 20_000
MAX_LIST = 32

_NO_KEY = (
    "No API key. Pass DecisionMachine(api_key=...) or set MS_API_KEY. "
    "Get a key at https://console.milliseconds.ai."
)

# yes-no has no `oneText` refine in decide.schema.ts, so a body the SDK would send
# without a statement comes back 200 and empty instead of 400.
_NO_STATEMENT = (
    'yes-no needs a statement. The API answers 200 with {"results":[]} for a body without one.'
)

# `answer` does refine question/questions, so an empty question is a plain 400.
_NO_QUESTION = "question is empty. Send a question about the text."


def api_key(key: str | None) -> str:
    if not key:
        raise client_error(_NO_KEY)
    return key


def text_input(value: str | Sequence[str]) -> None:
    """One text or a batch of 1 to 32, each at most 20,000 characters."""
    if isinstance(value, str):
        _chars("text", value)
        return
    n = len(value)
    if n == 0:
        raise client_error("texts is empty. Send at least one text.")
    if n > MAX_TEXTS:
        raise client_error(f"texts has {n} items. The limit is {MAX_TEXTS}. Split the batch.")
    for i, t in enumerate(value):
        _chars(f"texts[{i}]", t)


def _chars(where: str, value: str) -> None:
    if not value:
        raise client_error(f"{where} is empty. Send at least one character.")
    # The server measures UTF-16 code units, because `z.string().max(20_000)` reads the
    # length of a JavaScript string. An emoji counts twice there and once here, and the
    # middleware bills the call before it validates the body. Count the server's way.
    n = len(value.encode("utf-16-le")) // 2
    if n > MAX_CHARS:
        raise client_error(
            f"{where} is {n:,} characters. The limit is {MAX_CHARS:,}. "
            "Split on paragraphs and send the parts as texts."
        )


def statements(name: str, value: str | Sequence[str]) -> None:
    """1 to 32 statements or questions."""
    if isinstance(value, str):
        if not value:
            raise client_error(_NO_STATEMENT if name == "statements" else _NO_QUESTION)
        return
    n = len(value)
    if n == 0 or n > MAX_LIST:
        raise client_error(f"{name} has {n} items. Send 1 to {MAX_LIST}.")


def _entries(
    name: str, value: Sequence[str] | Mapping[str, str], capability: str, low: int, high: int
) -> None:
    if isinstance(value, str):
        # A str is a Sequence[str], so the type checker accepts it and `list()` would
        # send one entry per character. The server accepts that body and bills it.
        raise client_error(f"{name} is a string. A string sends one entry per letter. Send a list.")
    n = len(value)
    if isinstance(value, Mapping):
        # decide.schema.ts bounds the array branch of `Labels` and of `types` only. The
        # record branch carries no min and no max, so one name and 65 names are both legal.
        if n == 0:
            raise client_error(f"{name} is empty. {capability} needs at least one entry.")
        return
    if low <= n <= high:
        return
    if n == 0:
        raise client_error(f"{name} is empty. {capability} needs {low} to {high}.")
    unit = "entry" if n == 1 else "entries"
    raise client_error(f"{name} has {n} {unit}. {capability} needs {low} to {high}.")


def labels(value: Sequence[str] | Mapping[str, str]) -> None:
    """2 to 64 names. A name -> description dict is unbounded, as on the server."""
    _entries("labels", value, "classify", 2, 64)


def types(value: Sequence[str] | Mapping[str, str]) -> None:
    """1 to 64 names. The classify minimum is 2, so the two checks cannot be shared."""
    _entries("types", value, "entities", 1, 64)


def scale(value: Sequence[str]) -> None:
    _entries("scale", value, "rate", 2, 10)


def schema(value: Mapping[str, Any]) -> None:
    """`planFor` reads the root the same way: an absent `type` is a string, not an object."""
    declared = value.get("type")
    if not isinstance(declared, str):
        listed = cast("Sequence[str]", declared or [])
        declared = next((t for t in listed if t != "null"), None)
    if declared != "object" or not isinstance(value.get("properties"), Mapping):
        raise client_error("The schema must be an object with properties.")
