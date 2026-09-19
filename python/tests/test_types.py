"""assert_type on every overload shape.

`str` is itself a `Sequence[str]`, so the `str` overload must come first. A reorder
changes the inferred type and breaks nothing at runtime. This file is what catches it.
Pyright runs in strict mode, so a wrong shape here is a build failure.
"""

from __future__ import annotations

import sys
from typing import Any, Final, Literal, Mapping, TypedDict  # noqa: UP035

import pytest
from conftest import async_client, sync_client

from milliseconds import (
    AnswerResult,
    AsyncDecisionMachine,
    ClassifyResult,
    ClassifyTreeResult,
    DecisionMachine,
    Entity,
    RateResult,
    Results,
    VerifyResult,
    YesNoResult,
)

if sys.version_info >= (3, 11):
    from typing import assert_type
else:
    from typing_extensions import assert_type

Intent = Literal["billing", "shipping", "account"]

LABELS: Final[Mapping[Intent, str]] = {
    "billing": "payments, invoices, charges and refunds",
    "shipping": "delivery, tracking and packages",
    "account": "login, passwords and profile settings",
}

TEXTS: Final[list[str]] = ["a", "b"]

SCHEMA: Final[dict[str, Any]] = {
    "type": "object",
    "properties": {"total": {"type": "number"}},
}


class Invoice(TypedDict):
    invoice_number: str | None
    total: float | None


@pytest.fixture
def dm() -> DecisionMachine:
    return sync_client()


def test_yes_no_has_four_shapes(dm: DecisionMachine) -> None:
    assert_type(dm.yes_no("t", "s"), YesNoResult)
    assert_type(dm.yes_no("t", ["s"]), Results[YesNoResult])
    assert_type(dm.yes_no(TEXTS, "s"), Results[YesNoResult])
    assert_type(dm.yes_no(TEXTS, ["s"]), Results[Results[YesNoResult]])


def test_answer_has_four_shapes(dm: DecisionMachine) -> None:
    assert_type(dm.answer("t", "Who announced the product?"), AnswerResult)
    assert_type(dm.answer("t", ["Who announced the product?"]), Results[AnswerResult])
    assert_type(dm.answer(TEXTS, "Who announced the product?"), Results[AnswerResult])
    assert_type(dm.answer(TEXTS, ["Who announced the product?"]), Results[Results[AnswerResult]])


def test_classify_reads_an_annotated_label_constant(dm: DecisionMachine) -> None:
    r = dm.classify("t", LABELS)
    assert_type(r, ClassifyResult[Intent])
    assert_type(r.label, Intent)
    assert_type(dm.classify(TEXTS, LABELS), Results[ClassifyResult[Intent]])


def test_a_bare_dict_gives_str(dm: DecisionMachine) -> None:
    assert_type(dm.classify("t", {"billing": "x", "shipping": "y"}), ClassifyResult[str])


def test_classify_tree_is_always_str(dm: DecisionMachine) -> None:
    tree = {"billing": "money", "shipping": "parcels"}
    assert_type(dm.classify_tree("t", tree), ClassifyTreeResult)
    assert_type(dm.classify_tree(TEXTS, tree), Results[ClassifyTreeResult])


def test_rate(dm: DecisionMachine) -> None:
    scale: Final[list[str]] = ["Calm", "Annoyed", "Angry"]
    assert_type(dm.rate("t", scale), RateResult[str])
    assert_type(dm.rate(TEXTS, scale), Results[RateResult[str]])


def test_entities(dm: DecisionMachine) -> None:
    types: Final[Mapping[Literal["person"], str]] = {"person": "a human name"}
    assert_type(dm.entities("t", types), Results[Entity[Literal["person"]]])
    assert_type(dm.entities(TEXTS, types), Results[Results[Entity[Literal["person"]]]])


def test_verify(dm: DecisionMachine) -> None:
    assert_type(dm.verify("t", "invoice_number", 4471), VerifyResult)
    assert_type(dm.verify(TEXTS, {"name": "total"}, "120.00"), Results[VerifyResult])


def test_extract_follows_the_schema(dm: DecisionMachine) -> None:
    assert_type(dm.extract("t", Invoice), Invoice)
    assert_type(dm.extract(TEXTS, Invoice), Results[Invoice])
    assert_type(dm.extract("t", SCHEMA), dict[str, Any])
    assert_type(dm.extract(TEXTS, SCHEMA), Results[dict[str, Any]])


async def test_the_async_client_has_the_same_shapes() -> None:
    adm: AsyncDecisionMachine = async_client()
    assert_type(await adm.yes_no("t", "s"), YesNoResult)
    assert_type(await adm.yes_no(TEXTS, ["s"]), Results[Results[YesNoResult]])
    assert_type(await adm.classify("t", LABELS), ClassifyResult[Intent])
    assert_type(await adm.extract("t", Invoice), Invoice)
    await adm.aclose()
