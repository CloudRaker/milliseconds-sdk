"""Result types. Every field keeps its exact wire name."""

from __future__ import annotations

import os
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, fields
from typing import Any, Generic, Literal, TypedDict, TypeVar, cast, get_origin

if sys.version_info >= (3, 11):
    from typing import NotRequired
else:
    from typing_extensions import NotRequired

L = TypeVar("L", bound=str)
T = TypeVar("T")

__all__ = [
    "AnswerResult",
    "BBox",
    "Boxes",
    "CallOpts",
    "ClassifyResult",
    "ClassifyTreeLevel",
    "ClassifyTreeResult",
    "Entity",
    "Field",
    "RateLimit",
    "RateResult",
    "Results",
    "Tree",
    "TreeNode",
    "Usage",
    "VerifyResult",
    "YesNoResult",
]


Detail = Literal["low", "medium", "high"]
"""The longest edge the runner resizes to: 512, 768 or 1024 pixels."""

BBox = Sequence[int]
"""[x1, y1, x2, y2], in the pixels of the image you uploaded."""

Boxes = Mapping[str, BBox]
"""Dotted field path -> box. Empty when the model returned none."""


class CallOpts(TypedDict, total=False):
    """Per-call overrides. Every capability takes these as keyword arguments.

    `image` sends one JPEG, PNG or WebP, at most 5 MB, beside the text or in place
    of it. `detail` picks the resolution and the billed image tokens: low 1,000,
    medium 2,000, high 4,000. The generative capabilities bill a multiple of that,
    and those multipliers are provisional.
    """

    timeout: float
    max_retries: int
    headers: Mapping[str, str]
    #: One image: the bytes, a pathlib.Path, a data URL, or bare base64. Never a URL.
    image: bytes | str | os.PathLike[str]
    detail: Detail


class Field(TypedDict):
    """The field `verify` reads out of the text."""

    name: str
    description: NotRequired[str]


class TreeNode(TypedDict):
    """A tree entry. A node without `labels` is a leaf."""

    description: NotRequired[str]
    labels: NotRequired[Tree]


Tree = Mapping[str, "str | TreeNode"]
"""Nested labels: name -> description, or name -> {description, labels}."""


@dataclass(frozen=True, slots=True)
class RateLimit:
    """The limits as of the previous request at this Cloudflare colo.

    The middleware accounts after the response. Read these as a trailing gauge,
    never as admission control.
    """

    limit_requests: int
    remaining_requests: int
    reset_requests: str
    limit_tokens: int
    remaining_tokens: int
    reset_tokens: str


@dataclass(frozen=True, slots=True)
class Usage:
    """What one call read and billed."""

    input_chars: int
    input_tokens: int
    inference_ms: int
    rate_limit: RateLimit | None
    headers: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class YesNoResult:
    statement: str
    answer: bool
    probability: float
    usage: Usage = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class ClassifyResult(Generic[L]):
    label: L
    probability: float
    confidence: float
    scores: Mapping[L, float]
    usage: Usage = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class ClassifyTreeLevel:
    label: str
    probability: float
    confidence: float
    scores: Mapping[str, float]
    input_chars: int
    input_tokens: int
    inference_ms: int


@dataclass(frozen=True, slots=True)
class ClassifyTreeResult:
    """`label` is typed `str`. A nested dict carries no literal a TypeVar can solve."""

    path: Sequence[str]
    label: str
    probability: float
    confidence: float
    levels: Sequence[ClassifyTreeLevel]
    usage: Usage = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class RateResult(Generic[L]):
    """Route on `score`, never on `level`. `level` flips on 0.001."""

    score: float
    level: int
    label: L
    confidence: float
    scores: Sequence[float]
    usage: Usage = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class AnswerResult:
    question: str
    answer: str | None
    probability: float
    start: int | None
    end: int | None
    usage: Usage = field(repr=False, compare=False)
    #: The region in the uploaded image. None on text, and None when the model gave none.
    bbox: BBox | None = None

    @property
    def span(self) -> tuple[int, int] | None:
        """(start, end) when the model found a span, else None.

        The service sets answer, start and end together, or nulls all three.
        Python cannot narrow three fields from one check, so read the span here.
        """
        if self.start is None or self.end is None:
            return None
        return (self.start, self.end)


@dataclass(frozen=True, slots=True)
class Entity(Generic[L]):
    type: L
    text: str
    probability: float
    start: int
    end: int
    #: The region in the uploaded image. None on text, and None when the model gave none.
    bbox: BBox | None = None


@dataclass(frozen=True, slots=True)
class VerifyResult:
    matches: bool
    probability: float
    found: Sequence[str]
    usage: Usage = field(repr=False, compare=False)


class Results(list[T]):
    """A plain list, plus the usage of the one call that produced it."""

    usage: Usage

    def __init__(self, items: Iterable[T], usage: Usage) -> None:
        super().__init__(items)
        self.usage = usage


def build(cls: type[T], body: Mapping[str, Any], usage: Usage | None = None) -> T:
    """Build a result, dropping response fields this release does not know.

    The API promises additive changes. Without the filter a new response field
    raises TypeError in production.

    `cls` may be a parameterised alias such as ClassifyResult[str]. Building through
    the alias sets `__orig_class__` on the instance, which a frozen slotted dataclass
    refuses on Python 3.10, so the origin class is what gets called.
    """
    target: Any = get_origin(cls) or cls
    names = {f.name for f in fields(target)}
    data: dict[str, Any] = {k: v for k, v in body.items() if k in names}
    if usage is not None and "usage" in names:
        data["usage"] = usage
    return cast("T", target(**data))
