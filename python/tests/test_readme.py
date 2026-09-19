"""Run every python block of README.md, in order, against the fake API.

A snippet that stops working is a broken README, so it is a test failure.
"""

from __future__ import annotations

import re
import sys
import types
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import KEY, api

import milliseconds

README = Path(__file__).resolve().parents[1] / "README.md"
BLOCK = re.compile(r"^```python\n(.*?)^```", re.MULTILINE | re.DOTALL)


def blocks() -> list[str]:
    found = BLOCK.findall(README.read_text())
    assert found, "README.md has no python blocks"
    return found


def test_every_readme_snippet_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    real_sync = milliseconds.DecisionMachine
    real_async = milliseconds.AsyncDecisionMachine

    def sync(*_args: Any, **kw: Any) -> milliseconds.DecisionMachine:
        kw["http_client"] = httpx.Client(transport=httpx.MockTransport(api))
        return real_sync(KEY, **kw)

    def asyncc(*_args: Any, **kw: Any) -> milliseconds.AsyncDecisionMachine:
        kw["http_client"] = httpx.AsyncClient(transport=httpx.MockTransport(api))
        return real_async(KEY, **kw)

    monkeypatch.setattr(milliseconds, "DecisionMachine", sync)
    monkeypatch.setattr(milliseconds, "AsyncDecisionMachine", asyncc)

    # A real module, so `get_type_hints` can resolve a TypedDict the README declares.
    snippets = types.ModuleType("readme_snippets")
    monkeypatch.setitem(sys.modules, "readme_snippets", snippets)
    shared: dict[str, Any] = snippets.__dict__
    for i, code in enumerate(blocks()):
        try:
            exec(compile(code, f"README.md[block {i + 1}]", "exec"), shared)  # noqa: S102
        except Exception as exc:  # noqa: BLE001
            pytest.fail(f"README block {i + 1} failed: {exc!r}\n\n{code}")
