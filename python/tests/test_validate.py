"""Every client-side check of DESIGN.md section 8.1. Nothing reaches the network."""

from __future__ import annotations

import httpx
import pytest
from conftest import KEY

from milliseconds import DecisionMachine, InvalidRequestError

LABELS = {"billing": "charges", "shipping": "delivery"}
SCHEMA = {"type": "object", "properties": {"total": {"type": "number"}}}


def never(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"the SDK sent a request to {request.url}")


@pytest.fixture
def dm() -> DecisionMachine:
    """A client whose transport fails the test if anything is sent."""
    return DecisionMachine(KEY, http_client=httpx.Client(transport=httpx.MockTransport(never)))


def refuses(fn: object, message: str) -> None:
    with pytest.raises(InvalidRequestError) as caught:
        fn()  # pyright: ignore[reportCallIssue]
    assert caught.value.code == "client_error"
    assert caught.value.status == 0
    assert caught.value.api_message == message
    assert str(caught.value) == message


def test_no_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MS_API_KEY", raising=False)
    refuses(
        DecisionMachine,
        "No API key. Pass DecisionMachine(api_key=...) or set MS_API_KEY. "
        "Get a key at https://console.milliseconds.ai.",
    )


def test_the_key_falls_back_to_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MS_API_KEY", "sk-ms-from-env")
    assert DecisionMachine().api_key == "sk-ms-from-env"


def test_an_empty_input_array(dm: DecisionMachine) -> None:
    refuses(lambda: dm.classify([], LABELS), "texts is empty. Send at least one text.")


def test_over_32_texts(dm: DecisionMachine) -> None:
    refuses(
        lambda: dm.classify(["t"] * 41, LABELS),
        "texts has 41 items. The limit is 32. Split the batch.",
    )


def test_a_text_over_20000_characters(dm: DecisionMachine) -> None:
    texts = ["short", "short", "short", "x" * 24_110]
    refuses(
        lambda: dm.classify(texts, LABELS),
        "texts[3] is 24,110 characters. The limit is 20,000. "
        "Split on paragraphs and send the parts as texts.",
    )


def test_one_text_over_20000_characters(dm: DecisionMachine) -> None:
    refuses(
        lambda: dm.classify("x" * 24_110, LABELS),
        "text is 24,110 characters. The limit is 20,000. "
        "Split on paragraphs and send the parts as texts.",
    )


def test_yes_no_with_no_statement(dm: DecisionMachine) -> None:
    refuses(
        lambda: dm.yes_no("t", ""),
        'yes-no needs a statement. The API answers 200 with {"results":[]} for a body without one.',
    )


def test_an_empty_statements_array(dm: DecisionMachine) -> None:
    refuses(lambda: dm.yes_no("t", []), "statements has 0 items. Send 1 to 32.")


def test_over_32_statements(dm: DecisionMachine) -> None:
    refuses(lambda: dm.yes_no("t", ["s"] * 33), "statements has 33 items. Send 1 to 32.")


def test_an_empty_questions_array(dm: DecisionMachine) -> None:
    refuses(lambda: dm.answer("t", []), "questions has 0 items. Send 1 to 32.")


def test_too_few_labels(dm: DecisionMachine) -> None:
    refuses(lambda: dm.classify("t", ["billing"]), "labels has 1 entry. classify needs 2 to 64.")


def test_no_labels(dm: DecisionMachine) -> None:
    none: list[str] = []
    refuses(lambda: dm.classify("t", none), "labels is empty. classify needs 2 to 64.")


def test_too_many_labels(dm: DecisionMachine) -> None:
    labels = [f"l{i}" for i in range(65)]
    refuses(lambda: dm.classify("t", labels), "labels has 65 entries. classify needs 2 to 64.")


def test_no_entity_types(dm: DecisionMachine) -> None:
    none: list[str] = []
    refuses(lambda: dm.entities("t", none), "types is empty. entities needs 1 to 64.")


def test_one_entity_type_is_legal() -> None:
    """The classify minimum is 2 and the entities minimum is 1. One rule would be wrong."""
    from conftest import sync_client

    with sync_client() as client:
        assert client.entities("Ada", ["person"])[0].type == "person"


def test_too_many_scale_levels(dm: DecisionMachine) -> None:
    refuses(
        lambda: dm.rate("t", [f"l{i}" for i in range(12)]),
        "scale has 12 entries. rate needs 2 to 10.",
    )


def test_too_few_scale_levels(dm: DecisionMachine) -> None:
    refuses(lambda: dm.rate("t", ["Calm"]), "scale has 1 entry. rate needs 2 to 10.")


def test_a_schema_that_is_not_an_object(dm: DecisionMachine) -> None:
    refuses(
        lambda: dm.extract("t", {"type": "string"}),
        "The schema must be an object with properties.",
    )


def test_a_schema_with_no_properties(dm: DecisionMachine) -> None:
    refuses(
        lambda: dm.extract("t", {"type": "object"}),
        "The schema must be an object with properties.",
    )


def test_a_schema_with_no_type(dm: DecisionMachine) -> None:
    """`kindOf` reads an absent `type` as a string, so `planFor` would throw server side."""
    refuses(
        lambda: dm.extract("t", {"properties": {"total": {}}}),
        "The schema must be an object with properties.",
    )


def test_a_valid_schema_passes(dm: DecisionMachine) -> None:
    with pytest.raises(AssertionError, match="the SDK sent a request"):
        dm.extract("t", SCHEMA)


def test_a_string_where_a_list_belongs(dm: DecisionMachine) -> None:
    """`str` is a `Sequence[str]`, so the type checker passes it. One entry per letter."""
    refuses(
        lambda: dm.classify("t", "billing"),
        "labels is a string. A string sends one entry per letter. Send a list.",
    )
    refuses(
        lambda: dm.entities("t", "person"),
        "types is a string. A string sends one entry per letter. Send a list.",
    )
    refuses(
        lambda: dm.rate("t", "low"),
        "scale is a string. A string sends one entry per letter. Send a list.",
    )


def test_an_empty_text(dm: DecisionMachine) -> None:
    refuses(lambda: dm.classify("", LABELS), "text is empty. Send at least one character.")


def test_an_empty_text_inside_a_batch(dm: DecisionMachine) -> None:
    refuses(
        lambda: dm.classify(["ok", ""], LABELS), "texts[1] is empty. Send at least one character."
    )


def test_the_character_limit_counts_utf16_code_units(dm: DecisionMachine) -> None:
    """`z.string().max(20_000)` reads a JavaScript string length, so an emoji counts twice."""
    refuses(
        lambda: dm.classify("\U0001f680" * 10_001, LABELS),
        "text is 20,002 characters. The limit is 20,000. "
        "Split on paragraphs and send the parts as texts.",
    )


def test_an_empty_question_names_the_question(dm: DecisionMachine) -> None:
    """`answer` refines question/questions, so its trap is not the yes-no trap."""
    refuses(lambda: dm.answer("t", ""), "question is empty. Send a question about the text.")


def test_a_label_dict_is_unbounded_server_side() -> None:
    """decide.schema.ts bounds the array branch of `Labels` only. The record branch is free."""
    from conftest import sync_client

    with sync_client() as client:
        assert client.classify("t", {"billing": "charges and refunds"}).label == "billing"
        assert client.classify("t", {f"l{i}": "d" for i in range(65)}).label == "l0"


def test_an_empty_label_dict(dm: DecisionMachine) -> None:
    none: dict[str, str] = {}
    refuses(lambda: dm.classify("t", none), "labels is empty. classify needs at least one entry.")
