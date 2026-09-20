# @cloudraker/milliseconds

Typed decisions over text. The TypeScript SDK for `decision-machine-1` at
[milliseconds.ai](https://milliseconds.ai).

`decision-machine-1` decides. It does not generate. Send text and get a yes or no, a label, a
path through a label tree, a rating, an answer span, a filled JSON Schema, entities, or a
value check. Every call is one round trip and costs input tokens only.

The SDK adds the types. Your label names, your scale levels, your entity types and your
schema flow into the **result** type. No generator can do that, so this package is hand
written and stays hand written.

```sh
npm i @cloudraker/milliseconds     # pnpm add, bun add, yarn add
export MS_API_KEY=sk-ms-...        # https://console.milliseconds.ai
```

Zero runtime dependencies. TypeScript >= 5.0. Node >= 20, Bun, Deno, browsers and Cloudflare
Workers.

## Start here

```ts
import { DecisionMachine } from '@cloudraker/milliseconds'

const dm = new DecisionMachine() // reads MS_API_KEY

const r = await dm.classify(ticket, {
  billing: 'payments, invoices, charges and refunds',
  shipping: 'delivery, tracking and packages',
  account: 'login, passwords and profile settings',
})
// r: ClassifyResult<'billing' | 'shipping' | 'account'>
// r.label:       'billing' | 'shipping' | 'account'
// r.scores:      Record<'billing' | 'shipping' | 'account', number>
// r.probability: number
// r.confidence:  number
```

`r.label === 'shiping'` is a compile error here. That is the whole point.

Describe every label. The description is the instruction, and the model reads it literally.
Described labels score measurably better than bare names.

## The eight capabilities

```ts
// 1. classify — pick one label, get the full distribution
const intent = await dm.classify(ticket, ['billing', 'shipping', 'account'])
intent.label // 'billing' | 'shipping' | 'account'

// 2. yesNo — one inference call, many statements
const [urgent, asking] = await dm.yesNo(
  ticket,
  ['The customer expresses urgency.', 'The customer is asking about shipping.'],
  { when_true: 'Time pressure, ASAP, losing money' },
)
urgent.answer // boolean
urgent.statement // 'The customer expresses urgency.' — the literal, not string

// 3. rate — place the text on an ordered scale
const tone = await dm.rate(message, ['Calm', 'Annoyed', 'Angry', 'Threatening to leave'])
tone.score // number, 0 to 3. Route on this.
tone.level // 0 | 1 | 2 | 3
tone.label // 'Calm' | 'Annoyed' | 'Angry' | 'Threatening to leave'

// 4. answer — quote the answer out of the text, with offsets
const [who] = await dm.answer(article, ['Who announced the product?'])
if (who.answer !== null) article.slice(who.start, who.end) // start and end are numbers here

// 5. entities — every mention of every type
const found = await dm.entities(article, { person: 'a human name', place: 'a city or country' })
found[0]?.type // 'person' | 'place'

// 6. verify — check a value you already hold
const check = await dm.verify(invoiceText, 'invoice_number', 4471)
check.matches // boolean. check.found shows what the text says.

// 7. classifyTree — walk a nested taxonomy
const node = await dm.classifyTree(ticket, {
  billing: {
    description: 'payments, invoices, charges, refunds and subscriptions',
    labels: {
      refund_request: 'the customer asks for money back',
      subscription_change: 'the customer wants to upgrade, downgrade or cancel a plan',
    },
  },
  shipping: 'delivery, tracking, lost or damaged parcels',
})
node.label // 'refund_request' | 'subscription_change' | 'shipping' — a walk stops here
node.path // every label on the way down

// 8. extract — fill a JSON Schema
const data = await dm.extract(letter, {
  type: 'object',
  properties: {
    due_date: { description: 'the date the payment is due' },
    total: { type: 'number' },
  },
})
data.total // number | null
```

## Batching

One text gives one result. A tuple of texts gives a tuple of results, in order.

```ts
const one = await dm.classify(ticket, LABELS) // ClassifyResult<Intent>
const [a, b] = await dm.classify([t1, t2], LABELS) // a tuple of two
const many = await dm.classify(tickets, LABELS) // tickets: string[] -> ClassifyResult<Intent>[]

// Both axes at once: texts times statements.
const grid = await dm.yesNo([t1, t2], ['The text mentions a price.'])
// grid[0][0].answer
```

A hoisted label list needs `as const` to keep its union: `const LABELS = ['billing',
'shipping'] as const`. A plain `string[]`, read from a config file for example, types
`r.label` as `string`. The literal inline forms above need nothing.

A batch holds at most 32 texts, and each text at most 20,000 characters. The SDK never
chunks for you: chunking costs money and changes failure modes, so the caller decides.
`dm1 --lines` chunks, and says so.

## Extraction

A JSON Schema object literal types the result on its own.

```ts
const data = await dm.extract(letter, {
  type: 'object',
  properties: {
    reference: { type: 'string', enum: ['AB', 'CD'] },
    tags: { type: 'array', items: { type: 'string' } },
    line_items: { type: 'array', items: { type: 'object' } },
    vendor: { type: 'object', properties: { name: { type: 'string' } } },
  },
})
// reference:  'AB' | 'CD' | (string & {}) | null
// tags:       string[] | null
// line_items: never[]
// vendor:     { name: string | null }
```

Four degradations are real, and the types state them:

1. A missing value is `null`. Every scalar leaf is nullable.
2. An array of objects always comes back `[]`. Line-item quality is not good enough to ship.
3. An array of scalars comes back as strings. The runner calls `String()` on every element.
4. An enum is not checked server side. `(string & {})` admits reality and keeps autocomplete.

A nested object is never `null`. Only its leaves are.

zod and valibot need one line, because the SDK carries no dependency that converts them:

```ts
import { z } from 'zod'
import { typed } from '@cloudraker/milliseconds'

const Invoice = z.object({ total: z.number(), currency: z.enum(['USD', 'EUR']) })
const data = await dm.extract(pdfText, typed<z.infer<typeof Invoice>>(z.toJSONSchema(Invoice)))
// data.total: number | null
```

zod 4.2 and later give every schema its own `toJSONSchema()` method, so
`dm.extract(pdfText, Invoice)` works too and infers the same type. `typed<>` stays right for
valibot and older zod, where the converter is a module function.

An arktype schema passes straight in: `dm.extract(text, Invoice)`. The SDK calls its
`toJsonSchema()` and reads the output type from `~standard`.

## Images

Every capability reads one image. Send the bytes: the API never fetches a URL.

```ts
import { imageFile } from '@cloudraker/milliseconds/node'

// Or a Uint8Array, an ArrayBuffer, a Blob, a data URL, or bare base64.
const receipt = imageFile('receipt.jpg')

// No text at all: pass an empty first argument.
const kind = await dm.classify('', DOCUMENT_TYPES, { image: receipt })

// Text beside the image is read with it. `detail` picks the resolution.
const scanned = await dm.extract('the scan of a till receipt', RECEIPT, {
  image: receipt,
  detail: 'high',
})
```

`image` takes `Uint8Array`, `ArrayBuffer`, `Blob`, a `data:image/(jpeg|png|webp);base64,`
URL, or bare base64. `imageFile(path)` reads a file in Node. One image per call, at most
5 MB, JPEG, PNG or WebP. The SDK refuses a URL, another format and an over-size image
before the call.

`detail` sets the longest edge and the billed image tokens.

| detail | longest edge | image tokens |
| --- | --- | --- |
| `low` | 512 px | 1,000 |
| `medium` (default) | 768 px | 2,000 |
| `high` | 1024 px | 4,000 |

The base64 never enters the character count. `answer`, `extract`, `entities` and `verify`
generate on the image and bill a multiple of the tier above. **Those multipliers are
provisional.**

An image result carries no coordinates. An image answer has `start` and `end` null,
because there is no text to index.

The CLI takes the same two flags:

```sh
dm1 classify --image receipt.jpg --detail low invoice receipt letter
dm1 extract --image receipt.jpg --schema @receipt.json --json
```

## Usage and rate limits

```ts
const { result, usage, response } = await dm.classify(ticket, LABELS).withUsage()
usage.inputTokens // what this call bills
usage.inferenceMs // model time, summed over the calls this request made
usage.rateLimit // RateLimit | null
usage.headers // every response header
```

The rate-limit numbers come from the previous request at that Cloudflare colo. The API
accounts after the response. Read them as a trailing gauge. Never build admission control on
them.

## Errors and retries

```ts
import { isMillisecondsError } from '@cloudraker/milliseconds'

try {
  await dm.classify(ticket, LABELS)
} catch (e) {
  if (!isMillisecondsError(e)) throw e
  switch (e.code) {
    case 'rate_limit_exceeded':
      return wait(e.retryAfter) // seconds, or null
    case 'insufficient_quota':
      return topUp() // never retried: a timer will not help
    case 'invalid_request':
      return fix(e.apiMessage) // the wire text, unchanged
    default:
      throw e
  }
}
```

The SDK retries `429 rate_limit_exceeded`, `502 runner_error`, `529 overloaded`, and
transport failures and timeouts. Every capability is a pure function, so a retry is always
safe. It never retries `400`, `401` or `429 insufficient_quota`. `maxRetries` defaults to 2
and takes `0`. The backoff is full jitter, capped at 8 seconds, and a `retry-after` header
wins over the backoff.

`e.attempts` counts the attempts, including the first. `e.status` is `0` when the call never
reached the API.

A `502`, `503` or `504` with no JSON body is retried on the status alone. A Cloudflare error
page never reaches the worker, so it carries no code.

The SDK also checks your call before it sends anything: the label, statement, scale and text
limits, and the two API traps. Those throw `code: 'client_error'` with `status: 0`, and no
token is billed. They throw **synchronously**, before the `Decision` exists, so catch them
with `try`/`catch` around the call, not with `.catch()` on it.

## What the SDK changes, and nothing else

| Wire | SDK | Why |
| --- | --- | --- |
| `{ results: [...] }` | a plain array | one envelope less. The order is already guaranteed. |
| `{ entities: [...] }` | a plain array | the same |
| `{ data: {...} }` | the object itself | the same |
| `text` / `texts` | one positional `input` | the mutual exclusion becomes impossible |
| `statement` / `statements` | one positional argument | the same |
| `question` / `questions` | one positional argument | the same |
| `x-*` headers | `withUsage()` | the headers stay reachable, the results stay clean |

Every other field keeps its exact wire name, `snake_case` included: `when_true`,
`input_chars`, `inference_ms`, `probability`, `scores`, `start`, `end`.

`dm.post()` reaches the untouched body, and any future path:

```ts
const raw = await dm.post<unknown>('/v1/decision-machine-1/classify', { text, labels })
```

## Runtimes

Node >= 20, Bun and Deno work with no configuration. The SDK uses global `fetch` and ships
ESM, CJS and `.d.ts`.

Cloudflare Workers work the same way. Read the key from a secret binding and pass it as
`apiKey`.

In a browser the constructor throws. Your API key is a secret, and a bundle ships it to every
visitor. Call the API from your server. `dangerouslyAllowBrowser: true` opts out, and is
right only when the bundle never reaches a user.

## Gotchas

- `yes-no` answers `200` with `{"results":[]}` for a body that carries neither `text` nor
  `texts`. The SDK always sends one of the two, so that body cannot reach the API. An empty
  text is a `400`, and the SDK's local check only saves you the round trip.
- `classify-tree` sums `inference_ms` over every level into the header, while `x-input-chars`
  counts one pass over the body. The per-level numbers do not sum to `usage.inputChars`.
- `retry-after` rides on `429 rate_limit_exceeded` only. `e.retryAfter` is `null` on
  `insufficient_quota`.
- The six `x-ratelimit-*` headers arrive together or not at all. `usage.rateLimit` is `null`
  in the second case.

## Links

- Docs: [docs.milliseconds.ai](https://docs.milliseconds.ai)
- Console and keys: [console.milliseconds.ai](https://console.milliseconds.ai)
- Python: `pip install cloudraker-milliseconds`
- CLI: `npm i -g @cloudraker/milliseconds` then `dm1 --help`
