"""One call per capability against the live API. Shapes only, never values.

Skipped unless MS_API_KEY is set. Every call bills tokens, so keep it to one per
capability and do not loop.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any, Final, Literal, Mapping, TypedDict  # noqa: UP035

import pytest

from milliseconds import (
    AnswerResult,
    AsyncDecisionMachine,
    AuthenticationError,
    ClassifyResult,
    ClassifyTreeResult,
    DecisionMachine,
    Entity,
    RateResult,
    Results,
    Tree,
    VerifyResult,
    YesNoResult,
)

pytestmark = pytest.mark.skipif(not os.environ.get("MS_API_KEY"), reason="MS_API_KEY is not set")

TICKET = "I was charged twice for my subscription and support is not answering. Fix this today."
INVOICE = "Invoice 4471 from Acme Ltd. Total 120.00 EUR, due 2026-03-01."
PRESS = "Apple announced the M5 today. It costs 1999 dollars."

Intent = Literal["billing", "shipping", "account"]

LABELS: Final[Mapping[Intent, str]] = {
    "billing": "payments, invoices, charges and refunds",
    "shipping": "delivery, tracking and packages",
    "account": "login, passwords and profile settings",
}

SCALE: Final[list[str]] = ["Calm", "Annoyed", "Angry", "Threatening to leave"]

TREE: Final[Tree] = {
    "billing": {
        "description": "payments, invoices, charges, refunds and subscriptions",
        "labels": {
            "refund_request": "the customer asks for money back",
            "subscription_change": "the customer wants to upgrade, downgrade or cancel a plan",
        },
    },
    "shipping": "delivery, tracking, lost or damaged parcels",
}

SCHEMA: Final[dict[str, Any]] = {
    "type": "object",
    "properties": {
        "invoice_number": {"description": "the identifier printed on the invoice"},
        "total": {"type": "number", "description": "the amount due including tax"},
        "vendor": {"type": "object", "properties": {"name": {"type": "string"}}},
    },
}


class Invoice(TypedDict):
    invoice_number: str | None
    total: float | None


@pytest.fixture(scope="module")
def dm() -> Iterator[DecisionMachine]:
    with DecisionMachine() as client:
        yield client


def test_yes_no(dm: DecisionMachine) -> None:
    r = dm.yes_no(TICKET, "The customer expresses urgency.", when_true="time pressure, ASAP")
    assert isinstance(r, YesNoResult)
    assert isinstance(r.answer, bool)
    assert 0.0 <= r.probability <= 1.0
    assert r.usage.input_tokens > 0


def test_classify(dm: DecisionMachine) -> None:
    r = dm.classify(TICKET, LABELS)
    assert isinstance(r, ClassifyResult)
    assert r.label in LABELS
    assert set(r.scores) == set(LABELS)
    assert r.usage.inference_ms >= 0


def test_classify_tree(dm: DecisionMachine) -> None:
    r = dm.classify_tree(TICKET, TREE)
    assert isinstance(r, ClassifyTreeResult)
    assert r.label == r.path[-1]
    assert len(r.levels) >= 1


def test_rate(dm: DecisionMachine) -> None:
    r = dm.rate(TICKET, SCALE)
    assert isinstance(r, RateResult)
    assert r.label in SCALE
    assert len(r.scores) == len(SCALE)


def test_answer(dm: DecisionMachine) -> None:
    both = dm.answer(PRESS, ["Who announced the product?", "How much does it cost?"])
    assert isinstance(both, Results)
    assert len(both) == 2
    for r in both:
        assert isinstance(r, AnswerResult)
        assert (r.answer is None) == (r.span is None)


def test_extract(dm: DecisionMachine) -> None:
    data = dm.extract(INVOICE, SCHEMA)
    assert set(data) == {"invoice_number", "total", "vendor"}
    # A JSON number with no fraction decodes as `int`. PEP 484 accepts it where float is declared.
    assert data["total"] is None or isinstance(data["total"], (int, float))
    assert isinstance(data["vendor"], dict)  # setPath materialises a nested object


def test_extract_from_a_typed_dict(dm: DecisionMachine) -> None:
    data = dm.extract(INVOICE, Invoice)
    assert set(data) == {"invoice_number", "total"}


def test_entities(dm: DecisionMachine) -> None:
    found = dm.entities(PRESS, {"company": "a company name", "price": "an amount of money"})
    assert isinstance(found, Results)
    for e in found:
        assert isinstance(e, Entity)
        assert PRESS[e.start : e.end] == e.text


def test_verify(dm: DecisionMachine) -> None:
    r = dm.verify(INVOICE, {"name": "invoice_number", "description": "the invoice id"}, 4471)
    assert isinstance(r, VerifyResult)
    assert isinstance(r.matches, bool)


def test_a_batch_comes_back_in_order(dm: DecisionMachine) -> None:
    many = dm.classify([TICKET, "Where is my parcel?"], LABELS)
    assert len(many) == 2
    assert many.usage.input_tokens > 0


def test_usage_carries_the_rate_limit(dm: DecisionMachine) -> None:
    r = dm.classify("I was charged twice.", LABELS)
    limits = r.usage.rate_limit
    assert limits is None or limits.limit_requests > 0


def test_a_bad_key_raises_authentication_error() -> None:
    with DecisionMachine("sk-ms-nope-nope") as bad, pytest.raises(AuthenticationError) as caught:
        bad.classify("hello", LABELS)
    assert caught.value.status == 401


async def test_the_async_client_runs_every_capability() -> None:
    async with AsyncDecisionMachine() as adm:
        assert isinstance(await adm.yes_no(TICKET, "The customer is angry."), YesNoResult)
        assert isinstance(await adm.classify(TICKET, LABELS), ClassifyResult)
        assert isinstance(await adm.classify_tree(TICKET, TREE), ClassifyTreeResult)
        assert isinstance(await adm.rate(TICKET, SCALE), RateResult)
        assert isinstance(await adm.answer(PRESS, "Who announced the product?"), AnswerResult)
        assert set(await adm.extract(INVOICE, SCHEMA)) == set(SCHEMA["properties"])
        assert isinstance(await adm.entities(PRESS, ["company"]), Results)
        assert isinstance(await adm.verify(INVOICE, "total", "120.00"), VerifyResult)
