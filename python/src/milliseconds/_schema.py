"""Turn the `extract` schema argument into a JSON Schema, and the reply back into it.

Four shapes are accepted:

1. a pydantic v2 model, called by duck typing through `model_json_schema()`;
2. a `TypedDict`, walked with `typing.get_type_hints`;
3. a dataclass, walked the same way;
4. a plain `dict`, sent as is.

**Declare every field `| None`.** A missing value comes back as `None`, an array of
objects comes back as `[]`, and an array of scalars comes back as a list of strings.
Python cannot rewrite your annotation the way TypeScript does, so the annotation
must already admit what the runner sends.
"""

from __future__ import annotations

import dataclasses
import types as _types
import typing
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Literal, Union, cast, get_args, get_origin

from ._errors import client_error
from ._models import build

Loader = Callable[[Mapping[str, Any]], Any]

_DEFS = "#/$defs/"

_CYCLE = (
    "{name} refers to itself. extract fills a flat schema, so a recursive type "
    "has no shape to send."
)

_SCALARS: dict[Any, dict[str, Any]] = {
    str: {"type": "string"},
    int: {"type": "integer"},
    float: {"type": "number"},
    bool: {"type": "boolean"},
}

_UNIONS: tuple[Any, ...] = (Union, _types.UnionType)


def to_json_schema(schema: Any) -> tuple[dict[str, Any], Loader]:
    """Return the JSON Schema to send, and the function that rebuilds the reply."""
    model_json_schema = getattr(schema, "model_json_schema", None)
    if callable(model_json_schema):
        raw = cast("dict[str, Any]", model_json_schema())
        validate = getattr(schema, "model_validate")  # noqa: B009 - duck typed, never imported
        return _inline(raw, raw.get("$defs", {})), validate
    if typing.is_typeddict(schema):
        return _walk(schema), lambda data: dict(data)
    if dataclasses.is_dataclass(schema) and isinstance(schema, type):
        # The loader builds the top level only, so `_prop` refuses a nested dataclass.
        return _walk(schema), lambda data: build(schema, data)
    if isinstance(schema, Mapping):
        return dict(cast("Mapping[str, Any]", schema)), lambda data: dict(data)
    raise client_error(
        "The schema must be a JSON Schema dict, a TypedDict, a dataclass or a pydantic model."
    )


def _inline(node: Any, defs: Mapping[str, Any], seen: frozenset[str] = frozenset()) -> Any:
    """Resolve `$ref` and collapse `anyOf`/`oneOf` down to the one non-null branch.

    The runner's `kindOf` reads `type` and `enum` only. A `$ref` or an `anyOf` left
    in place reads as a string, so `total: float | None` would come back as text.
    """
    if isinstance(node, list):
        return [_inline(x, defs, seen) for x in cast("list[Any]", node)]
    if not isinstance(node, Mapping):
        return node
    obj = cast("Mapping[str, Any]", node)
    ref = obj.get("$ref")
    if isinstance(ref, str) and ref.startswith(_DEFS):
        name = ref[len(_DEFS) :]
        if name in seen:
            raise client_error(_CYCLE.format(name=name))
        return _inline(defs.get(name, {}), defs, seen | {name})
    branches = obj.get("anyOf") or obj.get("oneOf")
    if isinstance(branches, list):
        kept = [b for b in cast("list[Any]", branches) if b.get("type") != "null"]
        merged = {k: v for k, v in obj.items() if k not in ("anyOf", "oneOf")}
        if len(kept) == 1:
            merged.update(cast("dict[str, Any]", _inline(kept[0], defs, seen)))
        return merged
    return {k: _inline(v, defs, seen) for k, v in obj.items()}


def _walk(cls: Any, seen: frozenset[Any] = frozenset()) -> dict[str, Any]:
    if cls in seen:
        raise client_error(_CYCLE.format(name=getattr(cls, "__name__", cls)))
    try:
        hints = typing.get_type_hints(cls)
    except NameError as exc:
        raise client_error(
            f"{getattr(cls, '__name__', cls)} has an annotation the SDK cannot resolve: {exc}. "
            "Define the type at module level."
        ) from exc
    nested = seen | {cls}
    return {
        "type": "object",
        "properties": {name: _prop(cls, name, hint, nested) for name, hint in hints.items()},
    }


def _prop(cls: Any, name: str, hint: Any, seen: frozenset[Any] = frozenset()) -> dict[str, Any]:
    if get_origin(hint) in _UNIONS:
        rest = [a for a in get_args(hint) if a is not type(None)]
        if len(rest) != 1:
            raise client_error(
                f"{_where(cls, name)} is a union of {len(rest)} types. "
                "Declare one type, optionally `| None`."
            )
        return _prop(cls, name, rest[0], seen)
    if hint in _SCALARS:
        return dict(_SCALARS[hint])
    if get_origin(hint) is Literal:
        return {"type": "string", "enum": list(get_args(hint))}
    origin = get_origin(hint)
    if origin in (list, Sequence) or (isinstance(origin, type) and issubclass(origin, Sequence)):
        item = next(iter(get_args(hint)), str)
        if _is_object(item):
            # Arrays of objects are accepted and always come back empty.
            return {"type": "array", "items": {"type": "object"}}
        if item is not str:
            raise client_error(
                f"{_where(cls, name)} is a list of {getattr(item, '__name__', item)!s}. "
                "The runner stringifies every element, so declare list[str]."
            )
        return {"type": "array", "items": {"type": "string"}}
    if typing.is_typeddict(hint):
        return _walk(hint, seen)
    if _is_object(hint):
        raise client_error(
            f"{_where(cls, name)} is the dataclass {hint.__name__}. The SDK builds the top "
            "level only, so this field would hold a dict. Declare a nested TypedDict."
        )
    raise client_error(
        f"{_where(cls, name)} is {hint!r}, which extract does not support. "
        "Use str, int, float, bool, Literal, list[str], a nested TypedDict, or `| None`."
    )


def _is_object(hint: Any) -> bool:
    if typing.is_typeddict(hint):
        return True
    return isinstance(hint, type) and dataclasses.is_dataclass(hint)


def _where(cls: Any, name: str) -> str:
    return f"{getattr(cls, '__name__', cls)}.{name}"
