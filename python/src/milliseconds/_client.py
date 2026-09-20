"""The sync and the async client. Both are two lines on top of `_transport`."""

from __future__ import annotations

import asyncio
import os
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any, ClassVar, NamedTuple, TypeVar, overload

import httpx

from . import _image, _transport, _validate
from ._errors import MillisecondsError, make_error
from ._models import (
    AnswerResult,
    CallOpts,
    ClassifyResult,
    ClassifyTreeLevel,
    ClassifyTreeResult,
    Entity,
    Field,
    RateResult,
    Results,
    Tree,
    Usage,
    VerifyResult,
    YesNoResult,
    build,
)
from ._schema import to_json_schema

if sys.version_info >= (3, 11):
    from typing import Unpack
else:
    from typing_extensions import Unpack

__all__ = ["AsyncDecisionMachine", "DecisionMachine"]

L = TypeVar("L", bound=str)
T = TypeVar("T")

Parse = Callable[[Mapping[str, Any], Usage], Any]


class _Call(NamedTuple):
    capability: str
    body: dict[str, Any]
    # How many `{ results }` envelopes the reply carries: one per list argument sent.
    depth: int
    parse: Parse


# ---- reply parsing --------------------------------------------------------


def _unwrap(body: Any, depth: int, parse: Parse, usage: Usage) -> Any:
    if depth == 0:
        return parse(body, usage)
    return Results((_unwrap(r, depth - 1, parse, usage) for r in body["results"]), usage)


def _shape(body: Any, call: _Call, usage: Usage) -> Any:
    """Unwrap the envelopes. A reply of another shape is one SDK error, never a KeyError."""
    try:
        return _unwrap(body, call.depth, call.parse, usage)
    except MillisecondsError:
        raise
    except Exception as exc:  # noqa: BLE001 - any shape failure is one SDK error
        raise make_error(
            "internal_error", f"milliseconds sent a reply the SDK could not read: {exc}", status=200
        ) from exc


def _yes_no(body: Mapping[str, Any], usage: Usage) -> YesNoResult:
    return build(YesNoResult, body, usage)


def _classify(body: Mapping[str, Any], usage: Usage) -> ClassifyResult[str]:
    return build(ClassifyResult[str], body, usage)


def _rate(body: Mapping[str, Any], usage: Usage) -> RateResult[str]:
    return build(RateResult[str], body, usage)


def _answer(body: Mapping[str, Any], usage: Usage) -> AnswerResult:
    return build(AnswerResult, body, usage)


def _verify(body: Mapping[str, Any], usage: Usage) -> VerifyResult:
    return build(VerifyResult, body, usage)


def _tree(body: Mapping[str, Any], usage: Usage) -> ClassifyTreeResult:
    levels = [build(ClassifyTreeLevel, lv) for lv in body.get("levels", [])]
    return build(ClassifyTreeResult, {**body, "levels": levels}, usage)


def _entity_list(body: Mapping[str, Any], usage: Usage) -> Results[Entity[str]]:
    return Results((build(Entity[str], e) for e in body["entities"]), usage)


# ---- request building -----------------------------------------------------


def _listing(value: Sequence[str] | Mapping[str, str]) -> Any:
    return dict(value) if isinstance(value, Mapping) else list(value)


def _input(text: str | Sequence[str], opts: CallOpts) -> tuple[dict[str, Any], int]:
    """`Array.isArray(input)` picks `texts` over `text`. The reply follows the request.

    `image` and `detail` leave the call options here and join the body, so the
    transport never sees them. An image with an empty text sends no `text` at all.
    """
    image: Any = opts.pop("image", None)
    detail: Any = opts.pop("detail", None)
    _validate.text_input(text, image is not None)
    if isinstance(text, str):
        body: dict[str, Any] = {} if text == "" and image is not None else {"text": text}
        depth = 0
    else:
        body, depth = {"texts": list(text)}, 1
    if image is not None:
        body["image"] = _image.encode(image)
        if detail is not None:
            body["detail"] = _image.detail(detail)
    return body, depth


def _prep_yes_no(
    text: str | Sequence[str],
    statements: str | Sequence[str],
    when_true: str | None,
    when_false: str | None,
    opts: CallOpts,
) -> _Call:
    body, depth = _input(text, opts)
    _validate.statements("statements", statements)
    if isinstance(statements, str):
        body["statement"] = statements
    else:
        body["statements"] = list(statements)
        depth += 1
    if when_true is not None:
        body["when_true"] = when_true
    if when_false is not None:
        body["when_false"] = when_false
    return _Call("yes-no", body, depth, _yes_no)


def _prep_classify(
    text: str | Sequence[str], labels: Sequence[str] | Mapping[str, str], opts: CallOpts
) -> _Call:
    body, depth = _input(text, opts)
    _validate.labels(labels)
    body["labels"] = _listing(labels)
    return _Call("classify", body, depth, _classify)


def _prep_classify_tree(text: str | Sequence[str], tree: Tree, opts: CallOpts) -> _Call:
    body, depth = _input(text, opts)
    body["tree"] = dict(tree)
    return _Call("classify-tree", body, depth, _tree)


def _prep_rate(text: str | Sequence[str], scale: Sequence[str], opts: CallOpts) -> _Call:
    body, depth = _input(text, opts)
    _validate.scale(scale)
    body["scale"] = list(scale)
    return _Call("rate", body, depth, _rate)


def _prep_answer(
    text: str | Sequence[str], questions: str | Sequence[str], opts: CallOpts
) -> _Call:
    body, depth = _input(text, opts)
    _validate.statements("questions", questions)
    if isinstance(questions, str):
        body["question"] = questions
    else:
        body["questions"] = list(questions)
        depth += 1
    return _Call("answer", body, depth, _answer)


def _prep_extract(text: str | Sequence[str], schema: Any, opts: CallOpts) -> _Call:
    body, depth = _input(text, opts)
    json_schema, load = to_json_schema(schema)
    _validate.schema(json_schema)
    body["schema"] = json_schema

    def parse(b: Mapping[str, Any], _usage: Usage) -> Any:
        return load(b["data"])

    return _Call("extract", body, depth, parse)


def _prep_entities(
    text: str | Sequence[str], types: Sequence[str] | Mapping[str, str], opts: CallOpts
) -> _Call:
    body, depth = _input(text, opts)
    _validate.types(types)
    body["types"] = _listing(types)
    return _Call("entities", body, depth, _entity_list)


def _prep_verify(
    text: str | Sequence[str], field: str | Field, value: str | float, opts: CallOpts
) -> _Call:
    body, depth = _input(text, opts)
    body["field"] = {"name": field} if isinstance(field, str) else dict(field)
    body["value"] = value
    return _Call("verify", body, depth, _verify)


# ---- clients --------------------------------------------------------------


class _Base:
    model: ClassVar[str] = _transport.MODEL

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = _transport.DEFAULT_BASE_URL,
        timeout: float = 60.0,
        max_retries: int = 2,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.api_key = _validate.api_key(api_key or os.environ.get("MS_API_KEY"))
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self._headers = dict(headers or {})

    def _plan(self, path: str, opts: CallOpts) -> tuple[str, dict[str, str], float, int]:
        return (
            path if path.startswith("http") else f"{self.base_url}/{path.lstrip('/')}",
            _transport.headers(self.api_key, self._headers, opts.get("headers")),
            opts.get("timeout", self.timeout),
            opts.get("max_retries", self.max_retries),
        )


class DecisionMachine(_Base):
    """Typed decisions over text, against decision-machine-1.

    The key falls back to MS_API_KEY. Pass `http_client` to bring your own pool,
    proxy or transport.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = _transport.DEFAULT_BASE_URL,
        timeout: float = 60.0,
        max_retries: int = 2,
        headers: Mapping[str, str] | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            headers=headers,
        )
        self._http = http_client or httpx.Client()
        self._owns_http = http_client is None

    def close(self) -> None:
        """Close the pool. A pool you passed in is left alone."""
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> DecisionMachine:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _raw(self, path: str, body: Mapping[str, Any], opts: CallOpts) -> tuple[Any, Usage]:
        # ponytail: the async client repeats these twelve lines. The policy itself lives in
        # `_transport.retry_delay`, so only the `await` differs and the two cannot drift.
        url, headers, timeout, max_retries = self._plan(path, opts)
        started = time.monotonic()
        attempt = 1
        while True:
            err: MillisecondsError
            try:
                r = self._http.post(url, json=body, headers=headers, timeout=timeout)
                if r.status_code < 400:
                    return _transport.decode(r)
                err = _transport.error_for(r, attempt, time.monotonic() - started)
            except httpx.HTTPError as exc:
                err = _transport.error_for_exc(exc, attempt, time.monotonic() - started)
            delay = _transport.retry_delay(err, attempt, max_retries)
            if delay is None:
                raise err
            time.sleep(delay)
            attempt += 1

    def _send(self, call: _Call, opts: CallOpts) -> Any:
        data, usage = self._raw(f"/v1/{self.model}/{call.capability}", call.body, opts)
        return _shape(data, call, usage)

    @overload
    def yes_no(
        self,
        text: str,
        statements: str,
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> YesNoResult: ...
    @overload
    def yes_no(
        self,
        text: str,
        statements: Sequence[str],
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> Results[YesNoResult]: ...
    @overload
    def yes_no(
        self,
        text: Sequence[str],
        statements: str,
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> Results[YesNoResult]: ...
    @overload
    def yes_no(
        self,
        text: Sequence[str],
        statements: Sequence[str],
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> Results[Results[YesNoResult]]: ...

    def yes_no(
        self,
        text: Any,
        statements: Any,
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> Any:
        """Answer each statement with yes or no, and a probability.

        `when_true` and `when_false` sharpen the boundary. Statements share one
        inference call, so extra statements are nearly free.
        """
        return self._send(_prep_yes_no(text, statements, when_true, when_false, opts), opts)

    @overload
    def classify(
        self, text: str, labels: Sequence[L] | Mapping[L, str], **opts: Unpack[CallOpts]
    ) -> ClassifyResult[L]: ...
    @overload
    def classify(
        self, text: Sequence[str], labels: Sequence[L] | Mapping[L, str], **opts: Unpack[CallOpts]
    ) -> Results[ClassifyResult[L]]: ...

    def classify(self, text: Any, labels: Any, **opts: Unpack[CallOpts]) -> Any:
        """Pick one label and return the full distribution.

        Annotate the label constant (`Final[Mapping[Intent, str]]`) and the result
        carries `Intent`. Without the annotation you get `ClassifyResult[str]`.
        """
        return self._send(_prep_classify(text, labels, opts), opts)

    @overload
    def classify_tree(
        self, text: str, tree: Tree, **opts: Unpack[CallOpts]
    ) -> ClassifyTreeResult: ...
    @overload
    def classify_tree(
        self, text: Sequence[str], tree: Tree, **opts: Unpack[CallOpts]
    ) -> Results[ClassifyTreeResult]: ...

    def classify_tree(self, text: Any, tree: Tree, **opts: Unpack[CallOpts]) -> Any:
        """Run classify once per level, descending into the winner.

        `label` is `str`: Python cannot read literals out of a nested dict.
        Each level re-sends the text, so the per-level `input_chars` do not sum to
        `usage.input_chars`, which counts one pass over the body.
        """
        return self._send(_prep_classify_tree(text, tree, opts), opts)

    @overload
    def rate(self, text: str, scale: Sequence[L], **opts: Unpack[CallOpts]) -> RateResult[L]: ...
    @overload
    def rate(
        self, text: Sequence[str], scale: Sequence[L], **opts: Unpack[CallOpts]
    ) -> Results[RateResult[L]]: ...

    def rate(self, text: Any, scale: Any, **opts: Unpack[CallOpts]) -> Any:
        """Place the text on an ordered scale. Route on `score`, never on `level`."""
        return self._send(_prep_rate(text, scale, opts), opts)

    @overload
    def answer(self, text: str, questions: str, **opts: Unpack[CallOpts]) -> AnswerResult: ...
    @overload
    def answer(
        self, text: str, questions: Sequence[str], **opts: Unpack[CallOpts]
    ) -> Results[AnswerResult]: ...
    @overload
    def answer(
        self, text: Sequence[str], questions: str, **opts: Unpack[CallOpts]
    ) -> Results[AnswerResult]: ...
    @overload
    def answer(
        self, text: Sequence[str], questions: Sequence[str], **opts: Unpack[CallOpts]
    ) -> Results[Results[AnswerResult]]: ...

    def answer(self, text: Any, questions: Any, **opts: Unpack[CallOpts]) -> Any:
        """Quote the answer out of the text, with its offsets.

        `answer` is None when nothing fits, and `start` and `end` are then None too.
        Read the pair through `.span`.
        """
        return self._send(_prep_answer(text, questions, opts), opts)

    @overload
    def extract(self, text: str, schema: type[T], **opts: Unpack[CallOpts]) -> T: ...
    @overload
    def extract(
        self, text: str, schema: Mapping[str, Any], **opts: Unpack[CallOpts]
    ) -> dict[str, Any]: ...
    @overload
    def extract(
        self, text: Sequence[str], schema: type[T], **opts: Unpack[CallOpts]
    ) -> Results[T]: ...
    @overload
    def extract(
        self, text: Sequence[str], schema: Mapping[str, Any], **opts: Unpack[CallOpts]
    ) -> Results[dict[str, Any]]: ...

    def extract(self, text: Any, schema: Any, **opts: Unpack[CallOpts]) -> Any:
        """Fill a JSON Schema from the text.

        Declare every field `| None`. A missing value is None, an array of objects
        is always `[]`, and an array of scalars arrives as strings.
        """
        return self._send(_prep_extract(text, schema, opts), opts)

    @overload
    def entities(
        self, text: str, types: Sequence[L] | Mapping[L, str], **opts: Unpack[CallOpts]
    ) -> Results[Entity[L]]: ...
    @overload
    def entities(
        self, text: Sequence[str], types: Sequence[L] | Mapping[L, str], **opts: Unpack[CallOpts]
    ) -> Results[Results[Entity[L]]]: ...

    def entities(self, text: Any, types: Any, **opts: Unpack[CallOpts]) -> Any:
        """Find every span matching each type, sorted by start."""
        return self._send(_prep_entities(text, types, opts), opts)

    @overload
    def verify(
        self, text: str, field: str | Field, value: str | float, **opts: Unpack[CallOpts]
    ) -> VerifyResult: ...
    @overload
    def verify(
        self,
        text: Sequence[str],
        field: str | Field,
        value: str | float,
        **opts: Unpack[CallOpts],
    ) -> Results[VerifyResult]: ...

    def verify(self, text: Any, field: Any, value: Any, **opts: Unpack[CallOpts]) -> Any:
        """Check whether the text says `value` for `field`. A bare name is sent as {name}."""
        return self._send(_prep_verify(text, field, value, opts), opts)

    def post(self, path: str, body: Mapping[str, Any], **opts: Unpack[CallOpts]) -> Any:
        """Escape hatch: your path, your body, the SDK's auth, retries and errors."""
        return self._raw(path, body, opts)[0]


class AsyncDecisionMachine(_Base):
    """The same surface as DecisionMachine. Every capability is `async def`."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = _transport.DEFAULT_BASE_URL,
        timeout: float = 60.0,
        max_retries: int = 2,
        headers: Mapping[str, str] | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            headers=headers,
        )
        self._http = http_client or httpx.AsyncClient()
        self._owns_http = http_client is None

    async def aclose(self) -> None:
        """Close the pool. A pool you passed in is left alone."""
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncDecisionMachine:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def _raw(self, path: str, body: Mapping[str, Any], opts: CallOpts) -> tuple[Any, Usage]:
        url, headers, timeout, max_retries = self._plan(path, opts)
        started = time.monotonic()
        attempt = 1
        while True:
            err: MillisecondsError
            try:
                r = await self._http.post(url, json=body, headers=headers, timeout=timeout)
                if r.status_code < 400:
                    return _transport.decode(r)
                err = _transport.error_for(r, attempt, time.monotonic() - started)
            except httpx.HTTPError as exc:
                err = _transport.error_for_exc(exc, attempt, time.monotonic() - started)
            delay = _transport.retry_delay(err, attempt, max_retries)
            if delay is None:
                raise err
            await asyncio.sleep(delay)
            attempt += 1

    async def _send(self, call: _Call, opts: CallOpts) -> Any:
        data, usage = await self._raw(f"/v1/{self.model}/{call.capability}", call.body, opts)
        return _shape(data, call, usage)

    @overload
    async def yes_no(
        self,
        text: str,
        statements: str,
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> YesNoResult: ...
    @overload
    async def yes_no(
        self,
        text: str,
        statements: Sequence[str],
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> Results[YesNoResult]: ...
    @overload
    async def yes_no(
        self,
        text: Sequence[str],
        statements: str,
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> Results[YesNoResult]: ...
    @overload
    async def yes_no(
        self,
        text: Sequence[str],
        statements: Sequence[str],
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> Results[Results[YesNoResult]]: ...

    async def yes_no(
        self,
        text: Any,
        statements: Any,
        *,
        when_true: str | None = None,
        when_false: str | None = None,
        **opts: Unpack[CallOpts],
    ) -> Any:
        """Answer each statement with yes or no, and a probability."""
        return await self._send(_prep_yes_no(text, statements, when_true, when_false, opts), opts)

    @overload
    async def classify(
        self, text: str, labels: Sequence[L] | Mapping[L, str], **opts: Unpack[CallOpts]
    ) -> ClassifyResult[L]: ...
    @overload
    async def classify(
        self, text: Sequence[str], labels: Sequence[L] | Mapping[L, str], **opts: Unpack[CallOpts]
    ) -> Results[ClassifyResult[L]]: ...

    async def classify(self, text: Any, labels: Any, **opts: Unpack[CallOpts]) -> Any:
        """Pick one label and return the full distribution."""
        return await self._send(_prep_classify(text, labels, opts), opts)

    @overload
    async def classify_tree(
        self, text: str, tree: Tree, **opts: Unpack[CallOpts]
    ) -> ClassifyTreeResult: ...
    @overload
    async def classify_tree(
        self, text: Sequence[str], tree: Tree, **opts: Unpack[CallOpts]
    ) -> Results[ClassifyTreeResult]: ...

    async def classify_tree(self, text: Any, tree: Tree, **opts: Unpack[CallOpts]) -> Any:
        """Run classify once per level, descending into the winner."""
        return await self._send(_prep_classify_tree(text, tree, opts), opts)

    @overload
    async def rate(
        self, text: str, scale: Sequence[L], **opts: Unpack[CallOpts]
    ) -> RateResult[L]: ...
    @overload
    async def rate(
        self, text: Sequence[str], scale: Sequence[L], **opts: Unpack[CallOpts]
    ) -> Results[RateResult[L]]: ...

    async def rate(self, text: Any, scale: Any, **opts: Unpack[CallOpts]) -> Any:
        """Place the text on an ordered scale. Route on `score`, never on `level`."""
        return await self._send(_prep_rate(text, scale, opts), opts)

    @overload
    async def answer(self, text: str, questions: str, **opts: Unpack[CallOpts]) -> AnswerResult: ...
    @overload
    async def answer(
        self, text: str, questions: Sequence[str], **opts: Unpack[CallOpts]
    ) -> Results[AnswerResult]: ...
    @overload
    async def answer(
        self, text: Sequence[str], questions: str, **opts: Unpack[CallOpts]
    ) -> Results[AnswerResult]: ...
    @overload
    async def answer(
        self, text: Sequence[str], questions: Sequence[str], **opts: Unpack[CallOpts]
    ) -> Results[Results[AnswerResult]]: ...

    async def answer(self, text: Any, questions: Any, **opts: Unpack[CallOpts]) -> Any:
        """Quote the answer out of the text, with its offsets."""
        return await self._send(_prep_answer(text, questions, opts), opts)

    @overload
    async def extract(self, text: str, schema: type[T], **opts: Unpack[CallOpts]) -> T: ...
    @overload
    async def extract(
        self, text: str, schema: Mapping[str, Any], **opts: Unpack[CallOpts]
    ) -> dict[str, Any]: ...
    @overload
    async def extract(
        self, text: Sequence[str], schema: type[T], **opts: Unpack[CallOpts]
    ) -> Results[T]: ...
    @overload
    async def extract(
        self, text: Sequence[str], schema: Mapping[str, Any], **opts: Unpack[CallOpts]
    ) -> Results[dict[str, Any]]: ...

    async def extract(self, text: Any, schema: Any, **opts: Unpack[CallOpts]) -> Any:
        """Fill a JSON Schema from the text. Declare every field `| None`."""
        return await self._send(_prep_extract(text, schema, opts), opts)

    @overload
    async def entities(
        self, text: str, types: Sequence[L] | Mapping[L, str], **opts: Unpack[CallOpts]
    ) -> Results[Entity[L]]: ...
    @overload
    async def entities(
        self, text: Sequence[str], types: Sequence[L] | Mapping[L, str], **opts: Unpack[CallOpts]
    ) -> Results[Results[Entity[L]]]: ...

    async def entities(self, text: Any, types: Any, **opts: Unpack[CallOpts]) -> Any:
        """Find every span matching each type, sorted by start."""
        return await self._send(_prep_entities(text, types, opts), opts)

    @overload
    async def verify(
        self, text: str, field: str | Field, value: str | float, **opts: Unpack[CallOpts]
    ) -> VerifyResult: ...
    @overload
    async def verify(
        self,
        text: Sequence[str],
        field: str | Field,
        value: str | float,
        **opts: Unpack[CallOpts],
    ) -> Results[VerifyResult]: ...

    async def verify(self, text: Any, field: Any, value: Any, **opts: Unpack[CallOpts]) -> Any:
        """Check whether the text says `value` for `field`."""
        return await self._send(_prep_verify(text, field, value, opts), opts)

    async def post(self, path: str, body: Mapping[str, Any], **opts: Unpack[CallOpts]) -> Any:
        """Escape hatch: your path, your body, the SDK's auth, retries and errors."""
        return (await self._raw(path, body, opts))[0]
