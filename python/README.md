# cloudraker-milliseconds

`decision-machine-1` decides about text. It answers a statement yes or no, picks a label,
walks a label tree, rates the text on a scale, quotes an answer with its offsets, fills a
JSON Schema, finds entities, and checks a value. It never generates prose. Each call takes
milliseconds.

This SDK adds the typed vocabulary. It keeps every wire name, unwraps three envelopes,
validates your arguments before it spends a token, retries the right failures, and raises
one exception tree you can catch by class.

```bash
pip install cloudraker-milliseconds
export MS_API_KEY=sk-ms-...        # get a key at https://console.milliseconds.ai
```

## What Python can and cannot infer

Python has no mapped types and no conditional return types. It cannot read your label names
out of a dict display. It **can** solve a `TypeVar` from an annotated constant. One
annotation buys the whole chain.

```python
from typing import Final, Literal, Mapping

from milliseconds import DecisionMachine

Intent = Literal["billing", "shipping", "account"]

LABELS: Final[Mapping[Intent, str]] = {
    "billing": "payments, invoices, charges and refunds",
    "shipping": "delivery, tracking and packages",
    "account": "login, passwords and profile settings",
}

dm = DecisionMachine()  # reads MS_API_KEY

r = dm.classify("I was charged twice.", LABELS)
r.label  # Intent. A match statement over it is exhaustive.
r.scores["billing"]  # ok. r.scores["refunds"] is a type error.
r.probability  # float
r.confidence  # float. 1 = one clear winner, 0 = flat.
```

Without the annotation you get `ClassifyResult[str]`. Nothing breaks. You lose only the
names. Keep every label set in one constants file and the annotation lands where the
constants already live.

`classify_tree` returns `label: str`. Python has no expression that reads literals out of a
nested dict.

## The eight capabilities

```python
statement = dm.yes_no(
    "Fix this today.",
    "The customer expresses urgency.",
    when_true="Time pressure, ASAP, losing money",
)
statement.answer  # bool
statement.probability  # float

label = dm.classify("I was charged twice.", LABELS)

tree = dm.classify_tree(
    "I want my money back.",
    {
        "billing": {
            "description": "payments, invoices, charges, refunds and subscriptions",
            "labels": {
                "refund_request": "the customer asks for money back",
                "subscription_change": "the customer wants to upgrade or cancel a plan",
            },
        },
        "shipping": "delivery, tracking, lost or damaged parcels",
    },
)
tree.path  # winning label per level, top to bottom
tree.label  # the deepest label

mood = dm.rate(
    "I am done with this company.",
    ["Calm", "Annoyed", "Angry", "Threatening to leave"],
)
mood.score  # 0 to len(scale) - 1. Route on this.
mood.level  # the most likely index. It flips on 0.001.

who = dm.answer("Apple announced the M5 today.", "Who announced the product?")
if who.span is not None:
    start, end = who.span

people = dm.entities("Ada met Grace in Paris.", {"person": "a human name", "place": "a city"})
[e.text for e in people]

check = dm.verify("Invoice 4471, total 120.00 EUR.", "invoice_number", 4471)
check.matches  # bool
check.found  # what the text actually says
```

Describe every label. The label text is the instruction, and the model reads it literally.
Described labels score measurably better than bare names.

Annotate a tree you keep in a constant, as you annotate a label set. A bare `TAXONOMY = {...}`
infers a wider type, and `classify_tree` then refuses it.

```python
from typing import Final

from milliseconds import Tree

TAXONOMY: Final[Tree] = {
    "billing": {
        "description": "payments, invoices, charges, refunds and subscriptions",
        "labels": {
            "refund_request": "the customer asks for money back",
            "subscription_change": "the customer wants to upgrade or cancel a plan",
        },
    },
    "shipping": "delivery, tracking, lost or damaged parcels",
}

walked = dm.classify_tree("I want my money back.", TAXONOMY)
walked.label
```

## Batching

Pass a list of texts for a batch. The reply follows your request, never the other way.

```python
tickets = ["I was charged twice.", "Where is my parcel?"]

many = dm.classify(tickets, LABELS)  # Results[ClassifyResult[Intent]]
many[0].label
many.usage.input_tokens  # the usage of the one call

grid = dm.yes_no(tickets, ["The text mentions a price.", "The customer is angry."])
grid[0][1].answer  # text 0, statement 1
```

The limits are 32 texts per call, and 20,000 characters per text. The SDK never splits a
batch for you. Splitting costs money and changes failure modes, so you decide.

## Extraction

Four schema shapes work: a plain `dict` JSON Schema, a `TypedDict`, a dataclass, and a
pydantic v2 model. The SDK never imports pydantic. It calls `model_json_schema()` by duck
typing.

**Declare every field `| None`.** A missing value comes back as `None`.

```python
from typing import Literal, TypedDict


class Invoice(TypedDict):
    invoice_number: str | None
    total: float | None
    currency: Literal["USD", "EUR"] | None


data = dm.extract("Invoice 4471, total 120.00 EUR.", Invoice)
data["total"]  # float | None
```

A plain dict carries descriptions, which raise accuracy:

```python
schema = {
    "type": "object",
    "properties": {
        "invoice_number": {"description": "the identifier printed on the invoice"},
        "total": {"type": "number", "description": "the amount due including tax"},
        "tags": {"type": "array", "items": {"type": "string"}},
    },
}
invoice = dm.extract("Invoice 4471, total 120.00 EUR.", schema)
```

Four degradations are real, and no Python annotation can hide them:

- a missing value is `None`;
- an array of objects always comes back `[]`;
- an array of scalars comes back as a list of strings;
- an enum is not checked on the server, so a value outside your `Literal` can arrive.

## Images

Every capability reads one image. Send the bytes: the API never fetches a URL.

```python
import base64

# In your code: Path("receipt.png"), the bytes you already hold, or a data URL.
receipt = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE"
    "hQGAhKmMIQAAAABJRU5ErkJggg=="
)

DOCUMENT_TYPES = {"receipt": "a till receipt", "invoice": "a supplier invoice"}
RECEIPT = {"type": "object", "properties": {"total": {"type": "string"}}}

# No text at all: pass an empty string.
kind = dm.classify("", DOCUMENT_TYPES, image=receipt)
kind.label

# Text beside the image is read with it. `detail` picks the resolution.
data = dm.extract("the scan of a till receipt", RECEIPT, image=receipt, detail="high")
data.get("boxes")  # dotted field path -> [x1, y1, x2, y2], on an image call
```

`image` takes `bytes`, a `pathlib.Path`, a `data:image/(jpeg|png|webp);base64,` URL, or
bare base64. One image per call, at most 5 MB, JPEG, PNG or WebP. The SDK refuses a URL,
another format and an over-size image before the call.

`detail` sets the longest edge and the billed image tokens.

| detail | longest edge | image tokens |
| --- | --- | --- |
| `low` | 512 px | 1,000 |
| `medium` (default) | 768 px | 2,000 |
| `high` | 1024 px | 4,000 |

The base64 never enters the character count. `answer`, `extract`, `entities` and `verify`
generate on the image and bill a multiple of the tier above. **Those multipliers are
provisional.**

Boxes come back in the pixels of the image you uploaded, and they are `None` when the
model returned none: `AnswerResult.bbox`, `Entity.bbox`, and a `boxes` key on the extract
result, keyed by the dotted field path. The `boxes` key needs a `dict` schema: a
dataclass, a `TypedDict` and a pydantic model hold no field for it, so it is dropped
there. An image answer carries no `start` and `end`, because there is no text to index.

## Usage and rate limits

Every result carries the usage of the call that produced it. A single-text `extract` and
`post()` are the two exceptions. Both return your own object, which has no place for the
usage. Send a one-text batch to reach it: `dm.extract([text], Invoice).usage`.

```python
r = dm.classify("I was charged twice.", LABELS)
r.usage.input_chars
r.usage.input_tokens  # what this call bills
r.usage.inference_ms  # model time, not wall clock
r.usage.headers["x-input-tokens"]  # every response header stays reachable

limits = r.usage.rate_limit  # RateLimit | None
if limits is not None:
    limits.remaining_requests
    limits.reset_requests  # '5m0s'
```

The rate-limit numbers come from the previous request at that Cloudflare colo. The server
accounts after the response. Read them as a trailing gauge. Never build admission control
on them.

## Errors and retries

```python
from milliseconds import (
    AuthenticationError,
    InvalidRequestError,
    MillisecondsError,
    OverloadedError,
    QuotaExceededError,
    RateLimitError,
)

try:
    r = dm.classify("I was charged twice.", LABELS)
except RateLimitError as e:
    print(e.retry_after, e.attempts)
except QuotaExceededError:
    print("add credits at https://console.milliseconds.ai")
except MillisecondsError as e:
    print(e.code, e.status, e.api_message)
```

The SDK retries `429 rate_limit_exceeded`, `502 runner_error`, `529 overloaded`, and
transport failures. Every capability is a pure function, so a retry is always safe. It never
retries `400`, `401` or `429 insufficient_quota`. A timer retry cannot fix a spent quota.

Pass `max_retries=0` to turn retries off. `max_retries` and `timeout` also work per call:
`dm.classify(text, LABELS, max_retries=5, timeout=10.0)`.

Some checks run before any HTTP call. They raise `InvalidRequestError` with code
`client_error` and status `0`. Nothing was sent, so no token was billed.

```python
try:
    dm.classify("I was charged twice.", ["billing"])
except InvalidRequestError as e:
    print(e.code)  # client_error
    print(e.api_message)  # labels has 1 entry. classify needs 2 to 64.
```

## What the SDK changes, and nothing else

| Wire | SDK | Why |
| --- | --- | --- |
| `{ "results": [...] }` | a plain list | one envelope less. The order is already guaranteed. |
| `{ "entities": [...] }` | a plain list | the same |
| `{ "data": {...} }` | the object itself | the same |
| `text` / `texts` | one positional argument | the mutual exclusion becomes impossible |
| `statement` / `statements` | one positional argument | the same |
| `question` / `questions` | one positional argument | the same |
| `x-*` headers | `.usage` | the headers stay reachable, the results stay clean |

Every other field keeps its exact wire name, `snake_case` included: `when_true`,
`input_chars`, `inference_ms`, `probability`, `scores`, `start`, `end`.

`dm.post()` reaches the untouched body:

```python
raw = dm.post("/v1/decision-machine-1/classify", {"text": "hi", "labels": ["a", "b"]})
raw["label"]
```

## Async, and your own pool

```python
import asyncio

from milliseconds import AsyncDecisionMachine


async def main() -> None:
    async with AsyncDecisionMachine() as adm:
        r = await adm.classify("I was charged twice.", LABELS)
        print(r.label)


asyncio.run(main())
```

Both clients share one transport module, so the retries, the error parsing and the header
parsing cannot drift. Pass `http_client=` to bring your own `httpx.Client` or
`httpx.AsyncClient`. The SDK closes only a pool it opened itself.

## Gotchas

- `yes-no` and `answer` are the two endpoints with no `text` refinement on the server. A body
  with no text returns `200` and `{"results": []}`. The SDK rejects that body instead.
- A `labels` or `types` dict has no size limit on the server. The 2-to-64 rule binds the list
  form only, and the SDK checks the same way.
- `classify_tree` re-sends the text at every level. The per-level `input_chars` therefore do
  not sum to `usage.input_chars`, which counts one pass over the body.
- The SDK reports `x-input-tokens`. It never estimates a cost.

## Links

- Docs: https://docs.milliseconds.ai
- Console and keys: https://console.milliseconds.ai
- The TypeScript SDK and the `dm1` CLI: `@cloudraker/milliseconds`
