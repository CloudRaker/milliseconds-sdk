"""A fake decision-machine-1 on httpx.MockTransport.

The shapes follow decide.routes.ts: `perText` wraps a batch as `{ results }`, and
`yes-no` and `answer` wrap their own list argument the same way.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping
from typing import Any

import httpx
import pytest

from milliseconds import AsyncDecisionMachine, DecisionMachine

KEY = "sk-ms-test-key"

USAGE_HEADERS = {
    "x-input-chars": "79",
    "x-input-tokens": "20",
    "x-inference-ms": "381",
}

RATE_LIMIT_HEADERS = {
    "x-ratelimit-limit-requests": "200",
    "x-ratelimit-remaining-requests": "199",
    "x-ratelimit-reset-requests": "5m0s",
    "x-ratelimit-limit-tokens": "1000000",
    "x-ratelimit-remaining-tokens": "999980",
    "x-ratelimit-reset-tokens": "1m0s",
}

ALL_HEADERS = {**USAGE_HEADERS, **RATE_LIMIT_HEADERS}

Handler = Callable[[httpx.Request], httpx.Response]


def error(status: int, code: str, message: str, **headers: str) -> httpx.Response:
    return httpx.Response(
        status, json={"error": {"code": code, "message": message}}, headers=headers
    )


def _said(statement: str) -> dict[str, Any]:
    return {"statement": statement, "answer": True, "probability": 0.93}


def _answered(question: str) -> dict[str, Any]:
    """`answer` sets answer, start and end together, or nulls all three."""
    if "Who" not in question:
        return {
            "question": question,
            "answer": None,
            "probability": 0.0,
            "start": None,
            "end": None,
        }
    return {
        "question": question,
        "answer": "John Ternus",
        "probability": 0.8,
        "start": 0,
        "end": 11,
    }


def _one(capability: str, body: Mapping[str, Any], text: str) -> Any:
    if capability == "yes-no":
        if "statement" in body:
            return _said(body["statement"])
        return {"results": [_said(s) for s in body["statements"]]}
    if capability == "answer":
        if "question" in body:
            return _answered(body["question"])
        return {"results": [_answered(q) for q in body["questions"]]}
    if capability == "classify":
        names = list(body["labels"])
        return {
            "label": names[0],
            "probability": 0.96,
            "confidence": 0.83,
            "scores": {n: 1.0 if i == 0 else 0.0 for i, n in enumerate(names)},
            "note": "an additive field this release does not know",
        }
    if capability == "classify-tree":
        return {
            "path": ["billing", "refund_request"],
            "label": "refund_request",
            "probability": 0.8,
            "confidence": 0.7,
            "levels": [
                {
                    "label": "billing",
                    "probability": 0.9,
                    "confidence": 0.8,
                    "scores": {"billing": 0.9, "shipping": 0.1},
                    "input_chars": len(text),
                    "input_tokens": 10,
                    "inference_ms": 40,
                }
            ],
        }
    if capability == "rate":
        levels = list(body["scale"])
        return {
            "score": 2.61,
            "level": len(levels) - 1,
            "label": levels[-1],
            "confidence": 0.74,
            "scores": [round(1 / len(levels), 4)] * len(levels),
        }
    if capability == "extract":
        props: Mapping[str, Any] = body["schema"]["properties"]
        return {"data": {name: None for name in props}}
    if capability == "entities":
        names = list(body["types"])
        return {
            "entities": [
                {"type": names[0], "text": "Ada", "probability": 0.9, "start": 0, "end": 3}
            ]
        }
    if capability == "verify":
        return {"matches": True, "probability": 0.91, "found": ["4471"]}
    raise AssertionError(f"unknown capability {capability}")


def api(request: httpx.Request) -> httpx.Response:
    """Answer any capability with a well-formed body of the right shape."""
    assert request.headers["authorization"] == f"Bearer {KEY}"
    body: dict[str, Any] = json.loads(request.content)
    capability = request.url.path.rsplit("/", 1)[-1]
    if "texts" in body:
        out: Any = {"results": [_one(capability, body, t) for t in body["texts"]]}
    else:
        out = _one(capability, body, body["text"])
    return httpx.Response(200, json=out, headers=ALL_HEADERS)


def sync_client(handler: Handler = api, **kw: Any) -> DecisionMachine:
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return DecisionMachine(KEY, http_client=http, **kw)


def async_client(handler: Handler = api, **kw: Any) -> AsyncDecisionMachine:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return AsyncDecisionMachine(KEY, http_client=http, **kw)


def recorder(handler: Handler = api) -> tuple[list[httpx.Request], Handler]:
    """Capture every request the SDK sends."""
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return seen, record


@pytest.fixture
def dm() -> Iterator[DecisionMachine]:
    client = sync_client()
    yield client
    client.close()
