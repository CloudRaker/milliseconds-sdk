"""One image per call: encoding, the 5 MB limit and the body shape."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import ALL_HEADERS, KEY, async_client, recorder, sync_client

from milliseconds import DecisionMachine, InvalidRequestError

PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE"
    "hQGAhKmMIQAAAABJRU5ErkJggg=="
)
PNG_BYTES = base64.b64decode(PNG_BASE64)
DATA_URL = f"data:image/png;base64,{PNG_BASE64}"

LABELS = {"receipt": "a till receipt", "invoice": "a supplier invoice"}


def body_of(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content)


def replying(payload: Any):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload, headers=ALL_HEADERS)

    return handler


# ---- the body -------------------------------------------------------------


def test_bytes_become_base64_and_the_text_is_dropped() -> None:
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.classify("", LABELS, image=PNG_BYTES, detail="low")
    assert body_of(seen[0]) == {"labels": LABELS, "image": PNG_BASE64, "detail": "low"}


def test_a_path_is_read_from_disk(tmp_path: Path) -> None:
    path = tmp_path / "pixel.png"
    path.write_bytes(PNG_BYTES)
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.classify("", LABELS, image=path)
    assert body_of(seen[0])["image"] == PNG_BASE64


def test_a_data_url_crosses_the_wire_unchanged() -> None:
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.classify("", LABELS, image=DATA_URL)
    assert body_of(seen[0])["image"] == DATA_URL


def test_text_beside_the_image_is_kept() -> None:
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.classify("the scan of a till receipt", LABELS, image=PNG_BASE64)
    assert body_of(seen[0]) == {
        "text": "the scan of a till receipt",
        "labels": LABELS,
        "image": PNG_BASE64,
    }


def test_every_capability_carries_the_image() -> None:
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.yes_no("", "The document is a receipt.", image=PNG_BASE64)
        dm.rate("", ["low", "high"], image=PNG_BASE64)
        dm.answer("", "What is the total?", image=PNG_BASE64)
        dm.entities("", ["person"], image=PNG_BASE64)
        dm.verify("", "total", "9.99", image=PNG_BASE64)
        dm.classify_tree("", {"billing": "money", "shipping": "parcels"}, image=PNG_BASE64)
        dm.extract(
            "", {"type": "object", "properties": {"total": {"type": "string"}}}, image=PNG_BASE64
        )
    assert len(seen) == 7
    assert all(body_of(r)["image"] == PNG_BASE64 for r in seen)


async def test_the_async_client_sends_the_same_body() -> None:
    seen, record = recorder()
    async with async_client(record) as dm:
        await dm.classify("", LABELS, image=PNG_BYTES)
    assert body_of(seen[0])["image"] == PNG_BASE64


def test_the_transport_never_sees_image_or_detail() -> None:
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.classify("", LABELS, image=PNG_BYTES, detail="high", timeout=5.0)
    assert seen[0].headers["authorization"] == f"Bearer {KEY}"
    assert body_of(seen[0])["detail"] == "high"


# ---- the refusals ---------------------------------------------------------


def test_an_empty_text_without_an_image_is_still_refused(dm: DecisionMachine) -> None:
    with pytest.raises(InvalidRequestError):
        dm.classify("", LABELS)


def test_a_url_is_refused(dm: DecisionMachine) -> None:
    with pytest.raises(InvalidRequestError, match="never fetches a URL"):
        dm.classify("", LABELS, image="https://example.com/receipt.jpg")


def test_over_five_megabytes_is_refused_from_the_length(dm: DecisionMachine) -> None:
    huge = "/9j/" + "A" * (-(-5 * 1024 * 1024 * 4 // 3))
    with pytest.raises(InvalidRequestError, match="5 MB"):
        dm.classify("", LABELS, image=huge)
    with pytest.raises(InvalidRequestError, match="5 MB"):
        dm.classify("", LABELS, image=b"\xff\xd8\xff" + b"\x00" * (5 * 1024 * 1024))


def test_another_format_is_refused(dm: DecisionMachine) -> None:
    with pytest.raises(InvalidRequestError, match="data:image/"):
        dm.classify("", LABELS, image="data:image/gif;base64,R0lGODlh")
    with pytest.raises(InvalidRequestError, match="data:image/"):
        dm.classify("", LABELS, image=12)  # type: ignore[arg-type]


def test_an_unknown_detail_tier_is_refused(dm: DecisionMachine) -> None:
    with pytest.raises(InvalidRequestError, match="detail takes"):
        dm.classify("", LABELS, image=PNG_BASE64, detail="ultra")  # type: ignore[typeddict-item]


def test_a_batch_of_texts_beside_an_image_is_refused(dm: DecisionMachine) -> None:
    with pytest.raises(InvalidRequestError, match="text or texts"):
        dm.classify(["one", "two"], LABELS, image=PNG_BASE64)


# ---- the image as the input -----------------------------------------------


def test_bytes_as_the_first_argument_are_the_image() -> None:
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.classify(PNG_BYTES, LABELS, detail="low")
    assert body_of(seen[0]) == {"labels": LABELS, "image": PNG_BASE64, "detail": "low"}


def test_a_path_as_the_first_argument_is_the_image(tmp_path: Path) -> None:
    path = tmp_path / "receipt.png"
    path.write_bytes(PNG_BYTES)
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.yes_no(path, "This is a receipt.")
    assert body_of(seen[0])["image"] == PNG_BASE64
    assert "text" not in body_of(seen[0])


def test_a_data_url_as_the_first_argument_is_the_image() -> None:
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.classify(DATA_URL, LABELS)
    assert body_of(seen[0]) == {"labels": LABELS, "image": DATA_URL}


def test_an_image_input_and_image_keyword_together_are_refused() -> None:
    seen, record = recorder()
    with sync_client(record) as dm, pytest.raises(InvalidRequestError, match="One image per call"):
        dm.classify(PNG_BYTES, LABELS, image=PNG_BYTES)
    assert seen == []


def test_bare_base64_as_the_first_argument_stays_text() -> None:
    seen, record = recorder()
    with sync_client(record) as dm:
        dm.classify(PNG_BASE64, LABELS)
    assert body_of(seen[0]) == {"text": PNG_BASE64, "labels": LABELS}
