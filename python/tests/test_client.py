"""Transport, request bodies, envelopes, usage, errors and retries."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

import httpx
import pytest
from conftest import (
    ALL_HEADERS,
    USAGE_HEADERS,
    api,
    async_client,
    error,
    recorder,
    sync_client,
)

from milliseconds import (
    AnswerResult,
    AuthenticationError,
    ClassifyResult,
    ConnectionError,
    DecisionMachine,
    Entity,
    InvalidRequestError,
    MillisecondsError,
    OverloadedError,
    QuotaExceededError,
    RateLimitError,
    Results,
    RunnerError,
)

LABELS = {"billing": "charges and refunds", "shipping": "delivery and tracking"}


class Node(TypedDict):
    """A type that refers to itself. `extract` fills a flat schema, so it has no shape."""

    name: str | None
    parent: Node | None


def body_of(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content)


# ---- request shape --------------------------------------------------------


def test_one_text_sends_text(dm: DecisionMachine) -> None:
    seen, record = recorder()
    with sync_client(record) as client:
        client.classify("one ticket", LABELS)
    assert body_of(seen[0]) == {"text": "one ticket", "labels": LABELS}
    assert seen[0].url.path == "/v1/decision-machine-1/classify"


def test_a_list_sends_texts() -> None:
    seen, record = recorder()
    with sync_client(record) as client:
        client.classify(["a", "b"], LABELS)
    assert body_of(seen[0]) == {"texts": ["a", "b"], "labels": LABELS}


def test_one_statement_sends_statement() -> None:
    seen, record = recorder()
    with sync_client(record) as client:
        client.yes_no("t", "The customer is angry.", when_true="shouting")
    assert body_of(seen[0]) == {
        "text": "t",
        "statement": "The customer is angry.",
        "when_true": "shouting",
    }


def test_several_statements_send_statements() -> None:
    seen, record = recorder()
    with sync_client(record) as client:
        client.yes_no("t", ["one", "two"])
    assert body_of(seen[0]) == {"text": "t", "statements": ["one", "two"]}


def test_a_bare_field_name_is_sent_as_an_object() -> None:
    seen, record = recorder()
    with sync_client(record) as client:
        client.verify("t", "invoice_number", 4471)
    assert body_of(seen[0])["field"] == {"name": "invoice_number"}


def test_the_user_agent_and_extra_headers_travel() -> None:
    seen, record = recorder()
    with sync_client(record, headers={"x-team": "support"}) as client:
        client.classify("t", LABELS, headers={"x-run": "7"})
    assert seen[0].headers["user-agent"].startswith("cloudraker-milliseconds-python/")
    assert seen[0].headers["x-team"] == "support"
    assert seen[0].headers["x-run"] == "7"


def test_headers_cannot_override_authorization() -> None:
    seen, record = recorder()
    with sync_client(record, headers={"authorization": "Bearer nope"}) as client:
        client.classify("t", LABELS)
    assert seen[0].headers["authorization"] == "Bearer sk-ms-test-key"


# ---- envelopes ------------------------------------------------------------


def test_results_envelope_becomes_a_list(dm: DecisionMachine) -> None:
    many = dm.classify(["a", "b"], LABELS)
    assert isinstance(many, Results)
    assert [r.label for r in many] == ["billing", "billing"]


def test_entities_envelope_becomes_a_list(dm: DecisionMachine) -> None:
    found = dm.entities("Ada met Grace", ["person"])
    assert isinstance(found[0], Entity)
    assert found[0].text == "Ada"


def test_data_envelope_becomes_the_object(dm: DecisionMachine) -> None:
    data = dm.extract("t", {"type": "object", "properties": {"total": {"type": "number"}}})
    assert data == {"total": None}


def test_a_batch_of_statements_nests_twice(dm: DecisionMachine) -> None:
    grid = dm.yes_no(["a", "b"], ["one", "two"])
    assert [r.statement for r in grid[0]] == ["one", "two"]
    assert len(grid) == 2


def test_a_batch_of_entities_nests(dm: DecisionMachine) -> None:
    found = dm.entities(["a", "b"], {"person": "a human name"})
    assert found[0][0].type == "person"


def test_one_text_one_question_is_not_wrapped(dm: DecisionMachine) -> None:
    r = dm.answer("t", "Who announced the product?")
    assert isinstance(r, AnswerResult)
    assert r.span == (0, 11)


def test_a_null_answer_nulls_the_span(dm: DecisionMachine) -> None:
    r = dm.answer("t", "How much does it cost?")
    assert r.answer is None
    assert r.span is None


def test_tree_levels_are_built(dm: DecisionMachine) -> None:
    r = dm.classify_tree("t", {"billing": "money", "shipping": "parcels"})
    assert r.levels[0].input_tokens == 10
    assert r.path == ["billing", "refund_request"]


# ---- usage ----------------------------------------------------------------


def test_usage_reads_all_nine_headers(dm: DecisionMachine) -> None:
    r = dm.classify("t", LABELS)
    assert (r.usage.input_chars, r.usage.input_tokens, r.usage.inference_ms) == (79, 20, 381)
    assert r.usage.rate_limit is not None
    assert r.usage.rate_limit.remaining_requests == 199
    assert r.usage.rate_limit.reset_requests == "5m0s"
    assert r.usage.headers["x-input-tokens"] == "20"


def test_no_rate_limit_headers_gives_none() -> None:
    def bare(request: httpx.Request) -> httpx.Response:
        full = api(request)
        return httpx.Response(200, content=full.content, headers=USAGE_HEADERS)

    with sync_client(bare) as client:
        assert client.classify("t", LABELS).usage.rate_limit is None


def test_a_batch_carries_usage_on_the_list(dm: DecisionMachine) -> None:
    many = dm.classify(["a", "b"], LABELS)
    assert many.usage.input_tokens == 20
    assert many[0].usage.input_tokens == 20


def test_an_unknown_response_field_does_not_raise(dm: DecisionMachine) -> None:
    r = dm.classify("t", LABELS)
    assert isinstance(r, ClassifyResult)
    assert not hasattr(r, "note")


# ---- retries and errors ---------------------------------------------------


def _flaky(*responses: httpx.Response) -> tuple[list[httpx.Request], Any]:
    seen: list[httpx.Request] = []
    queue = list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return queue.pop(0) if queue else api(request)

    return seen, handler


def test_one_529_then_200() -> None:
    seen, handler = _flaky(error(529, "overloaded", "all slots busy"))
    with sync_client(handler) as client:
        assert client.classify("t", LABELS).label == "billing"
    assert len(seen) == 2


def test_a_429_rate_limit_is_retried_and_honours_retry_after() -> None:
    seen, handler = _flaky(
        error(429, "rate_limit_exceeded", "Retry after 0s.", **{"retry-after": "0"})
    )
    with sync_client(handler) as client:
        assert client.classify("t", LABELS).label == "billing"
    assert len(seen) == 2


def test_retries_stop_and_the_error_counts_the_attempts() -> None:
    seen, handler = _flaky(*[error(529, "overloaded", "busy")] * 3)
    with sync_client(handler, max_retries=2) as client, pytest.raises(OverloadedError) as caught:
        client.classify("t", LABELS)
    assert len(seen) == 3
    assert caught.value.attempts == 3
    assert caught.value.retryable is True
    assert "3 attempts" in str(caught.value)


def test_max_retries_zero_sends_once() -> None:
    seen, handler = _flaky(*[error(529, "overloaded", "busy")] * 3)
    with sync_client(handler, max_retries=0) as client, pytest.raises(OverloadedError):
        client.classify("t", LABELS)
    assert len(seen) == 1


def test_a_400_is_not_retried() -> None:
    seen, handler = _flaky(
        error(400, "invalid_request", "labels: Too small: expected array to have >=2 items")
    )
    with sync_client(handler) as client, pytest.raises(InvalidRequestError) as caught:
        client.classify("t", LABELS)
    assert len(seen) == 1
    assert caught.value.status == 400
    assert caught.value.retryable is False
    assert "classify needs two or more labels" in str(caught.value)


def test_insufficient_quota_is_not_retried() -> None:
    seen, handler = _flaky(error(429, "insufficient_quota", "no credits left"))
    with sync_client(handler) as client, pytest.raises(QuotaExceededError) as caught:
        client.classify("t", LABELS)
    assert len(seen) == 1
    assert caught.value.retry_after is None
    assert "A timer retry will not help" in str(caught.value)


def test_a_401_raises_authentication_error() -> None:
    seen, handler = _flaky(error(401, "invalid_api_key", "Incorrect API key provided."))
    with sync_client(handler) as client, pytest.raises(AuthenticationError) as caught:
        client.classify("t", LABELS)
    assert len(seen) == 1
    assert 'Keys start with "sk-ms-"' in str(caught.value)


def test_a_transport_failure_raises_connection_error() -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nodename nor servname provided")

    with sync_client(broken, max_retries=1) as client, pytest.raises(ConnectionError) as caught:
        client.classify("t", LABELS)
    assert caught.value.code == "connection_error"
    assert caught.value.status is None
    assert caught.value.attempts == 2


def test_a_timeout_raises_connection_error_with_the_timeout_code() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    with sync_client(slow, max_retries=0) as client, pytest.raises(ConnectionError) as caught:
        client.classify("t", LABELS)
    assert caught.value.code == "timeout"


def test_rate_limit_headers_reach_the_error() -> None:
    _, handler = _flaky(
        error(429, "rate_limit_exceeded", "slow down", **{**ALL_HEADERS, "retry-after": "0"})
    )
    with sync_client(handler, max_retries=0) as client, pytest.raises(RateLimitError) as caught:
        client.classify("t", LABELS)
    assert caught.value.rate_limit is not None
    assert caught.value.retry_after == 0.0


def test_post_reaches_the_raw_body(dm: DecisionMachine) -> None:
    raw = dm.post("/v1/decision-machine-1/entities", {"text": "t", "types": ["person"]})
    assert "entities" in raw


def test_a_client_it_did_not_open_is_left_alone() -> None:
    http = httpx.Client(transport=httpx.MockTransport(api))
    DecisionMachine("sk-ms-test-key", http_client=http).close()
    assert http.is_closed is False
    http.close()


# ---- the async client behaves the same ------------------------------------


async def test_async_parity() -> None:
    async with async_client() as client:
        r = await client.classify("t", LABELS)
        assert r.label == "billing"
        grid = await client.yes_no(["a", "b"], ["one", "two"])
        assert grid[1][0].statement == "one"
        found = await client.entities("Ada", {"person": "a human name"})
        assert found[0].text == "Ada"
        data = await client.extract("t", {"type": "object", "properties": {"a": {}}})
        assert data == {"a": None}
        assert r.usage.input_tokens == 20


async def test_async_retries_and_raises() -> None:
    seen, handler = _flaky(error(529, "overloaded", "busy"))
    async with async_client(handler) as client:
        assert (await client.classify("t", LABELS)).label == "billing"
    assert len(seen) == 2

    _, handler = _flaky(error(400, "invalid_schema", "schema must be an object"))
    async with async_client(handler) as client:
        with pytest.raises(InvalidRequestError):
            await client.classify("t", LABELS)


# ---- extraction schemas ---------------------------------------------------


class Vendor(TypedDict):
    name: str | None


class Invoice(TypedDict):
    invoice_number: str | None
    total: float | None
    currency: Literal["USD", "EUR"] | None
    tags: list[str] | None
    vendor: Vendor | None


@dataclass
class Receipt:
    total: float | None
    paid: bool | None


@dataclass
class Vendor2:
    name: str | None


@dataclass
class Bill:
    vendor: Vendor2 | None


def sent_schema(schema: Any) -> dict[str, Any]:
    seen, record = recorder()
    with sync_client(record) as client:
        client.extract("t", schema)
    return body_of(seen[0])["schema"]


def test_a_typed_dict_becomes_a_json_schema() -> None:
    assert sent_schema(Invoice) == {
        "type": "object",
        "properties": {
            "invoice_number": {"type": "string"},
            "total": {"type": "number"},
            "currency": {"type": "string", "enum": ["USD", "EUR"]},
            "tags": {"type": "array", "items": {"type": "string"}},
            "vendor": {"type": "object", "properties": {"name": {"type": "string"}}},
        },
    }


def test_a_dataclass_becomes_a_json_schema_and_comes_back_typed(dm: DecisionMachine) -> None:
    assert sent_schema(Receipt) == {
        "type": "object",
        "properties": {"total": {"type": "number"}, "paid": {"type": "boolean"}},
    }
    assert dm.extract("t", Receipt) == Receipt(total=None, paid=None)


def test_a_plain_dict_passes_through() -> None:
    schema = {"type": "object", "properties": {"total": {"type": "number"}}}
    assert sent_schema(schema) == schema


def test_a_pydantic_model_is_read_by_duck_typing() -> None:
    pydantic = pytest.importorskip("pydantic")

    class Line(pydantic.BaseModel):
        sku: str | None = None

    class Bill(pydantic.BaseModel):
        total: float | None = None
        currency: Literal["USD", "EUR"] | None = None
        vendor: Line | None = None

    sent = sent_schema(Bill)
    # `$ref` and `anyOf` are collapsed: the runner's kindOf reads `type` and `enum` only.
    assert sent["properties"]["total"]["type"] == "number"
    assert sent["properties"]["currency"]["enum"] == ["USD", "EUR"]
    assert sent["properties"]["vendor"]["properties"]["sku"]["type"] == "string"


def test_a_pydantic_model_comes_back_validated(dm: DecisionMachine) -> None:
    pydantic = pytest.importorskip("pydantic")

    class Bill(pydantic.BaseModel):
        total: float | None = None

    assert dm.extract("t", Bill) == Bill(total=None)


def test_an_unsupported_annotation_is_refused() -> None:
    class Bad(TypedDict):
        when: set[str] | None

    with sync_client() as client, pytest.raises(InvalidRequestError) as caught:
        client.extract("t", Bad)
    assert "Bad.when" in str(caught.value)


# ---- headers the caller sends ---------------------------------------------


def test_a_capital_authorization_cannot_override_the_key() -> None:
    """Header names are case insensitive. A second `Authorization` line is a 400 at the edge."""
    seen, record = recorder()
    with sync_client(record, headers={"Authorization": "Bearer nope"}) as client:
        client.classify("t", LABELS, headers={"Content-Type": "text/plain"})
    assert seen[0].headers.get_list("authorization") == ["Bearer sk-ms-test-key"]
    assert seen[0].headers.get_list("content-type") == ["text/plain"]


def test_a_caller_user_agent_wins() -> None:
    """DESIGN 5.2 reserves `authorization` only, as the TypeScript SDK does."""
    seen, record = recorder()
    with sync_client(record, headers={"user-agent": "mine/1"}) as client:
        client.classify("t", LABELS)
    assert seen[0].headers["user-agent"] == "mine/1"


# ---- error pages that never reached the worker ----------------------------


def _page(status: int) -> httpx.Response:
    """What Cloudflare returns when the worker is unreachable."""
    return httpx.Response(status, text="<html><title>error</title><center>cloudflare</center>")


def test_an_html_529_is_still_retried() -> None:
    seen, handler = _flaky(_page(529))
    with sync_client(handler) as client:
        assert client.classify("t", LABELS).label == "billing"
    assert len(seen) == 2


def test_an_html_502_is_a_runner_error() -> None:
    _, handler = _flaky(*[_page(502)] * 3)
    with sync_client(handler, max_retries=0) as client, pytest.raises(RunnerError) as caught:
        client.classify("t", LABELS)
    assert caught.value.code == "runner_error"
    assert caught.value.retryable is True


def test_an_html_520_is_an_internal_error() -> None:
    _, handler = _flaky(_page(520))
    with sync_client(handler) as client, pytest.raises(MillisecondsError) as caught:
        client.classify("t", LABELS)
    assert caught.value.code == "internal_error"
    assert caught.value.retryable is False


def test_a_reply_the_sdk_cannot_read_raises_one_error() -> None:
    def not_json(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="OK")

    with sync_client(not_json) as client, pytest.raises(MillisecondsError) as caught:
        client.classify("t", LABELS)
    assert caught.value.code == "internal_error"

    def wrong_shape(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"oops": 1})

    with sync_client(wrong_shape) as client, pytest.raises(MillisecondsError) as caught:
        client.classify(["a", "b"], LABELS)
    assert caught.value.code == "internal_error"


def test_post_takes_a_path_without_a_leading_slash(dm: DecisionMachine) -> None:
    seen, record = recorder()
    with sync_client(record) as client:
        client.post("v1/decision-machine-1/entities", {"text": "t", "types": ["person"]})
    assert str(seen[0].url) == "https://api.milliseconds.ai/v1/decision-machine-1/entities"


# ---- schemas the SDK refuses ----------------------------------------------


def test_a_recursive_type_is_refused() -> None:
    with sync_client() as client, pytest.raises(InvalidRequestError) as caught:
        client.extract("t", Node)
    assert "Node refers to itself" in str(caught.value)


def test_a_list_of_numbers_is_refused() -> None:
    class Order(TypedDict):
        amounts: list[float] | None

    with sync_client() as client, pytest.raises(InvalidRequestError) as caught:
        client.extract("t", Order)
    assert "Order.amounts is a list of float" in str(caught.value)


def test_a_nested_dataclass_is_refused() -> None:
    with sync_client() as client, pytest.raises(InvalidRequestError) as caught:
        client.extract("t", Bill)
    assert "Bill.vendor is the dataclass Vendor2" in str(caught.value)


def test_a_type_declared_inside_a_function_is_refused() -> None:
    """`from __future__ import annotations` hides a local name from get_type_hints."""

    class Line(TypedDict):
        sku: str | None

    class Local(TypedDict):
        line: Line | None

    with sync_client() as client, pytest.raises(InvalidRequestError) as caught:
        client.extract("t", Local)
    assert "Define the type at module level" in str(caught.value)
