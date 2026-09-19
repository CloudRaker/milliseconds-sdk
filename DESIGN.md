# milliseconds-sdk — design

Repository `CloudRaker/milliseconds-sdk`. Two packages, one version, one tag.

| Package | Registry | Import |
| --- | --- | --- |
| `@cloudraker/milliseconds` (`typescript/`) | npm | `import { DecisionMachine } from '@cloudraker/milliseconds'` |
| `cloudraker-milliseconds` (`python/`) | PyPI | `from milliseconds import DecisionMachine` |
| `dm1` | the npm package's `bin` | `npm i -g @cloudraker/milliseconds` |

Both packages target `decision-machine-1` at `https://api.milliseconds.ai`. Later models
become sibling classes in the same packages. Only the class name is model specific.

Three engineers can work in parallel: TypeScript SDK (`typescript/src`, minus `cli/`),
Python SDK (`python/`), CLI (`typescript/src/cli/`). The CLI depends on the TS SDK's public
surface, which this document fixes.

---

## 1. Why the SDK is hand written

A generator reads the OpenAPI document and emits `label: string` and
`scores: Record<string, number>`. The whole value of this SDK is the opposite: your label
names, your scale levels, your entity types and your schema flow into the **result** types.
No generator can do that. Never point Fern or `orval` at this repository.

The reference bar is TypeSafe's Jev SDK. Jev returns typed answers, so you stop parsing.
This SDK returns typed **vocabulary**, so you stop misspelling. `r.label === 'shiping'` is a
compile error here.

---

## 2. Rules the whole design obeys

1. **Wire names never change.** A field that crosses the wire keeps its exact
   `decide.schema.ts` name, `snake_case` included: `when_true`, `input_chars`,
   `inference_ms`, `probability`, `scores`, `start`, `end`. Only SDK-invented names are
   camelCase: `maxRetries`, `baseUrl`, `Usage.inputTokens`. A reader moves between the docs
   and the SDK with no translation table.
2. **Methods are positional.** `dm.classify(input, labels, options?)`. The first argument is
   `string | readonly string[]`, so `text` and `texts` become one slot. The mutual exclusion
   becomes impossible to express instead of a runtime 400.
3. **Three single-key envelopes are unwrapped.** `{ results }` becomes an array,
   `{ entities }` becomes an array, `{ data }` becomes the object. Nothing else changes.
   Section 9 holds the mapping table that both READMEs repeat.
4. **The SDK validates at the trust boundary.** It rejects locally what the server rejects,
   plus the two documented API traps. Section 8 holds the table.
5. **The SDK never chunks a batch.** Chunking costs money and changes failure modes, so the
   caller decides. `dm1 --lines` chunks, and says so.
6. **Docs and READMEs use ASD-STE100.** Active voice. Sentences under 30 words. Two ideas
   per sentence at most. No filler.

---

## 3. What the API really returns

Every claim below is read out of the worker source. Type the SDK to this, not to the
OpenAPI document.

| Source fact | File | Effect on the SDK |
| --- | --- | --- |
| `answer` returns `{answer, probability, start, end}` all set, or `answer`/`start`/`end` all `null` with `probability: 0`. Never mixed. | `decide.service.ts` `answer()` | `AnswerResult` is a discriminated union. |
| `kindOf` maps **every** non-object array to kind `string[]`, and `coerce` runs `value.map(String)`. | `lib/json-schema.ts` | An array of numbers arrives as `string[]`. |
| `coerce` returns `null` for a missing or empty value, for the whole field. | `lib/json-schema.ts` | A scalar array is `string[] \| null`. A null **element** never happens. |
| An array of objects pushes a `ListPlan` with `fields: []`, and `assemble` writes `[]` unconditionally. | `lib/json-schema.ts` | An array of objects is `never[]`. Never null. |
| `setPath` walks `cur[key] ??= {}`, so a nested object is always materialised. | `lib/json-schema.ts` | A nested object is **not** nullable. Only its leaves are. |
| `kindOf` returns `'string'` when `type` is absent, and `'string'` for any `enum`. | `lib/json-schema.ts` | A property with only a `description` is extracted as a string. An enum is never validated server side. |
| An unsupported `type` is skipped by `scalarFields`, so `assemble` never writes the key. | `lib/json-schema.ts` | That property is `undefined`. |
| `planFor` never reads `schema.required`. | `lib/json-schema.ts` | `required` is sent and changes no type. |
| `labels` is `.min(2).max(64)`. `types` (entities) is `.min(1).max(64)`. `scale` is `.min(2).max(10)`. | `decide.schema.ts` | Three different client-side checks. One rule would be wrong. |
| `texts`, `statements` and `questions` are each `.min(1).max(32)`. Each text is `.max(20_000)`. | `decide.schema.ts` | Empty array and over-limit are client-side errors. |
| `YesNoRequest` and `AnswerRequest` refine their own plural pair only. Neither has the `oneText` refine. | `decide.schema.ts` | `yes-no` and `answer` accept a body with no `text` and answer `200` with `{"results":[]}`. A missing statement or question is a normal 400. The SDK rejects an empty text client-side. |
| `oneText` returns false when you send neither, and the message is the fixed string `provide text or texts, not both`. | `decide.schema.ts` | The wire message misleads. The SDK must beat it. |
| `classify-tree` sums `inference_ms` over every level into the header, while `x-input-chars` stays one pass over the body. | `decide.routes.ts` | The per-level numbers do not sum to the header. Say so in the doc comment. |
| `retry-after` is set only on `429 rate_limit_exceeded`. | `api-key.middleware.ts` `refuse()` | `retryAfter` is null on `insufficient_quota`. |
| `headers()` writes all six `x-ratelimit-*` values together, or none. | `namespace/rate-limit.ts` | `Usage.rateLimit` is `RateLimit \| null`. The six fields inside are not nullable. |
| `unsupported_request` is thrown only by the `/v1/chat/completions` facade. | `modules/openai/openai.service.ts` | It is not in `ErrorCode`. The facade is out of scope. |
| Tokens are `ceil(chars / 4.1)`, computed from the whole body. | `lib/runner.ts` | The SDK reports `x-input-tokens` and never computes a cost. |

Reachable error codes for the eight capabilities: `invalid_request`, `invalid_schema` (400),
`missing_api_key`, `invalid_api_key` (401), `rate_limit_exceeded`, `insufficient_quota`
(429), `runner_error` (502), `overloaded` (529), `http_error` (4xx), `internal_error` (500).

---

## 4. File layout

```
milliseconds-sdk/
  LICENSE                       already present
  README.md                     repository front page, links to both packages
  DESIGN.md                     this file
  .github/workflows/ci.yml
  .github/workflows/publish.yml
  typescript/
    package.json
    tsconfig.json
    tsdown.config.ts
    README.md                   the npm page
    src/
      index.ts                  public exports only
      client.ts                 transport: fetch, retries, errors, usage, Decision<T>
      decision-machine.ts       class DecisionMachine
      errors.ts                 MillisecondsError, isMillisecondsError
      validate.ts               the client-side checks of section 8
      schema.ts                 runtime: any schema -> JSON Schema
      types.ts                  every public type and every inference helper
      cli/
        index.ts                #!/usr/bin/env node — parseArgs, dispatch, exit codes
        commands.ts             the capability table
        input.ts                positionals, --file, --lines, stdin, JSON body passthrough
        spec.ts                 name=description parsing, @file loading
        print.ts                table, JSON, NDJSON, colour, isatty
    test/
      types.test-d.ts           expectTypeOf: every claim in section 10
      client.test.ts            stubbed fetch: retries, usage, errors, body shape
      validate.test.ts          every row of section 8
      cli.test.ts               argv in, body and stdout out
      live.test.ts              skipped unless MS_API_KEY is set
  python/
    pyproject.toml
    README.md                   the PyPI page
    src/milliseconds/
      __init__.py               public exports
      _transport.py             shared: url, headers, retries, error parsing, usage parsing
      _client.py                DecisionMachine, AsyncDecisionMachine
      _models.py                frozen dataclasses, Results
      _errors.py                the exception tree
      _schema.py                TypedDict / dataclass / pydantic -> JSON Schema
      _validate.py              the client-side checks of section 8
      py.typed
    tests/
      test_client.py            httpx.MockTransport
      test_types.py             assert_type on every overload shape
      test_validate.py
      test_live.py              skipped unless MS_API_KEY is set
```

Prerequisite for the workspace: add `milliseconds-sdk` to `[monorepo].config_roots` in
`.config/mise/conf.d/monorepo.toml`, then run `ccc index`.

---

## 5. The TypeScript surface

Zero runtime dependencies. Global `fetch`. ESM, CJS and `.d.ts`. TypeScript >= 5.0, because
`const` type parameters carry the literals. Node >= 20, Bun, Deno, browsers, Cloudflare
Workers.

### 5.1 Exports

```ts
export { DecisionMachine } from './decision-machine'
export { MillisecondsError, isMillisecondsError } from './errors'
export { typed } from './schema'
export type * from './types'
```

Nothing model specific lives at the package root except the class name.

### 5.2 Client options

```ts
export interface ClientOptions {
  /** Your key. Falls back to MS_API_KEY in the environment. */
  apiKey?: string
  /** Default 'https://api.milliseconds.ai'. A trailing slash is trimmed. */
  baseUrl?: string
  /** Per attempt, in milliseconds. Default 60_000. */
  timeout?: number
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number
  /** Merged into every request. It cannot override `authorization`. */
  headers?: Record<string, string>
  /** For tests or proxies. Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch
  /** The key is a secret. Set true only when the bundle never reaches a user. */
  dangerouslyAllowBrowser?: boolean
}

export interface CallOptions {
  timeout?: number
  maxRetries?: number
  signal?: AbortSignal
  headers?: Record<string, string>
}
```

The constructor reads `process.env.MS_API_KEY` inside a `try`, so a Worker or a browser
without `process` does not throw.

### 5.3 Decision, usage and rate limits

```ts
/** A Promise of the result. `withUsage()` reaches the headers. */
export type Decision<T> = Promise<T> & {
  withUsage(): Promise<{ result: T; usage: Usage; response: Response }>
}

export interface Usage {
  /** x-input-chars */
  inputChars: number
  /** x-input-tokens — what this call bills. */
  inputTokens: number
  /** x-inference-ms — model time, summed over the calls this request made. */
  inferenceMs: number
  /** Null when the response carried no x-ratelimit-* headers. */
  rateLimit: RateLimit | null
  /** Every response header. Read a new x-* value with no SDK release. */
  headers: Headers
}

export interface RateLimit {
  limitRequests: number
  remainingRequests: number
  /** OpenAI style, for example '5m0s'. */
  resetRequests: string
  limitTokens: number
  remainingTokens: number
  resetTokens: string
}
```

The implementation is three lines and no `Promise` subclass:

```ts
const decision = <T>(p: Promise<{ result: T; usage: Usage; response: Response }>): Decision<T> =>
  Object.assign(p.then((r) => r.result), { withUsage: () => p })
```

`await dm.classify(...)` gives the result. `.withUsage()` gives the result plus the usage.
The result object keeps the wire shape. Nothing rides on a symbol, so `structuredClone`, a
JSON round trip and a React Server Component boundary all keep working.

The rate-limit numbers come from the previous request at that Cloudflare colo. The
middleware accounts after the response. Read them as a trailing gauge, never as admission
control. The doc comment says this.

### 5.4 Errors

```ts
export type ErrorCode =
  | 'invalid_request' | 'invalid_schema'          // 400
  | 'missing_api_key' | 'invalid_api_key'         // 401
  | 'rate_limit_exceeded' | 'insufficient_quota'  // 429
  | 'runner_error'                                // 502
  | 'overloaded'                                  // 529
  | 'http_error' | 'internal_error'               // 4xx / 500
  | 'connection_error' | 'timeout'                // no response
  | 'client_error'                                // raised before any HTTP call
  | (string & {})                                 // a code shipped after this release

export declare class MillisecondsError extends Error {
  readonly name: 'MillisecondsError'
  readonly code: ErrorCode
  /** 0 when the call never reached the API. */
  readonly status: number
  /** The API's own message, unchanged. `message` adds one hint line. */
  readonly apiMessage: string
  /** Seconds from the retry-after header. Only 429 rate_limit_exceeded carries it. */
  readonly retryAfter: number | null
  readonly rateLimit: RateLimit | null
  readonly response: Response | null
  /** Attempts this call made, including the first. */
  readonly attempts: number
  /** True for the codes the SDK retries. */
  readonly retryable: boolean
}
export function isMillisecondsError(e: unknown): e is MillisecondsError
```

One class. Users switch on `code`, which the union narrows exhaustively and which never goes
stale when the API adds a code. `isMillisecondsError` uses a brand property, so it survives a
duplicated copy of the package in a bundle.

`message` is the API message plus one hint line. Section 8.2 holds the copy.

### 5.5 Inference helpers

```ts
export type Input = string | readonly string[]

/** One text gives one result. A tuple of texts gives a tuple of results, same length. */
export type Fan<T extends Input, R> =
  T extends readonly string[] ? { -readonly [K in keyof T]: R } : R

/** Label names, or name -> description. */
export type Labels = readonly string[] | Readonly<Record<string, string>>
export type LabelOf<L extends Labels> =
  L extends readonly (infer S extends string)[] ? S : Extract<keyof L, string>

/** 0 | 1 | ... | n-1 for a tuple. `number` for a plain array. */
export type IndexOf<S extends readonly unknown[]> =
  number extends S['length']
    ? number
    : Exclude<keyof S, keyof unknown[]> extends infer K
      ? K extends `${infer N extends number}` ? N : never
      : never

export interface TreeNode { readonly description?: string; readonly labels?: Tree }
export type Tree = { readonly [label: string]: string | TreeNode }

/** Every label at every level. What `path` can hold. */
export type TreeLabels<T> =
  | Extract<keyof T, string>
  | { [K in keyof T]: T[K] extends { labels: infer C extends object } ? TreeLabels<C> : never }[keyof T]

/** Only the labels a walk can stop on. What `label` is. */
export type LeafLabels<T> =
  { [K in keyof T]: T[K] extends { labels: infer C extends object } ? LeafLabels<C> : K }[keyof T] & string
```

`Labels` is a plain array union, not a two-element tuple. A label set loaded from a config
file is `string[]`, and a type that rejects it is hostile. The arity check of section 8 gives
a better message than a tuple mismatch ever could.

### 5.6 Results

```ts
export interface YesNoResult<S extends string = string> {
  statement: S
  answer: boolean
  probability: number
}

export interface ClassifyResult<L extends string = string> {
  label: L
  probability: number
  /** 1 = one clear winner. 0 = flat. */
  confidence: number
  scores: Record<L, number>
}

export interface ClassifyTreeLevel {
  label: string
  probability: number
  confidence: number
  /** Only this level's siblings. The keys are narrower than the tree. */
  scores: Record<string, number>
  input_chars: number
  input_tokens: number
  inference_ms: number
}

export interface ClassifyTreeResult<L extends string = string, Leaf extends L = L> {
  /** The winning label per level, top to bottom. */
  path: L[]
  /** The deepest label, the last of `path`. */
  label: Leaf
  /** The product over the levels. */
  probability: number
  confidence: number
  /**
   * One entry per level. The per-level `input_chars` and `input_tokens` do not sum to
   * `Usage.inputChars`: the header counts one pass over the body, each level re-sends the
   * text.
   */
  levels: ClassifyTreeLevel[]
}

export interface RateResult<S extends readonly string[] = readonly string[]> {
  /** The probability-weighted position, 0 to scale.length - 1. Route on this, not `level`. */
  score: number
  level: IndexOf<S>
  label: S[number]
  confidence: number
  /** One probability per level, in scale order. */
  scores: { -readonly [K in keyof S]: number }
}

/** The service sets answer, start and end together, or nulls all three. */
export type AnswerResult<Q extends string = string> =
  | { question: Q; answer: string; probability: number; start: number; end: number }
  | { question: Q; answer: null; probability: number; start: null; end: null }

export interface Entity<T extends string = string> {
  type: T
  text: string
  probability: number
  start: number
  end: number
}

export interface VerifyResult {
  matches: boolean
  probability: number
  /** What the text actually says for that field. */
  found: string[]
}
```

`ClassifyTreeLevel.scores` is `Record<string, number>` on purpose. Each level scores only its
own siblings, so a tree-wide key union would promise keys that cannot appear.

### 5.7 Extraction

```ts
export type JsonSchema = { readonly type?: string; readonly [k: string]: unknown }

/** A Standard Schema object: zod 4, valibot 1.1+, arktype. */
export interface StandardSchemaV1<Output = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly types?: { readonly input: unknown; readonly output: Output }
  }
}

/** A JSON Schema branded with the type it produces. */
export type Typed<T> = JsonSchema & { readonly '~milliseconds.output'?: T }
/** Brands a JSON Schema. One cast, no runtime cost. */
export declare function typed<T>(schema: JsonSchema): Typed<T>

export type ExtractSchema = JsonSchema | StandardSchemaV1 | Typed<unknown>

export type SchemaOutput<S> =
  S extends { '~milliseconds.output'?: infer T } ? ([unknown] extends [T] ? FromJsonSchema<S> : T)
  : S extends StandardSchemaV1<infer O> ? O
  : FromJsonSchema<S>
```

`FromJsonSchema<S>` reads a JSON Schema object literal at the type level, exactly as
`kindOf` reads it at runtime:

```ts
export type FromJsonSchema<S> =
  S extends { enum: readonly (infer E)[] } ? (E extends string ? E : string)
  : S extends { type: 'object' }
    ? (S extends { properties: infer P } ? { -readonly [K in keyof P]: FromJsonSchema<P[K]> } : Record<string, never>)
  : S extends { type: 'array' }
    ? (S extends { items: infer I } ? (I extends { type: 'object' } ? object[] : string[]) : string[])
  : S extends { type: 'string' } ? string
  : S extends { type: 'number' | 'integer' } ? number
  : S extends { type: 'boolean' } ? boolean
  : S extends { type: string } ? undefined   // unsupported: the key never appears in `data`
  : string                                   // no `type`: the runner treats it as a string
```

`Extracted<T>` then states what the runner really sends:

```ts
export type Extracted<T> =
  [T] extends [undefined] ? undefined
  : [T] extends [readonly unknown[]]
    ? (T extends readonly (infer E)[] ? ([E] extends [object] ? never[] : string[] | null) : never)
  : [T] extends [object] ? { -readonly [K in keyof T]-?: Extracted<NonNullable<T[K]>> }
  : [T] extends [string] ? T | (string & {}) | null
  : T | null
```

Four truths live in that type. A missing value is `null`. An array of objects is always `[]`.
An array of scalars arrives as strings. An enum is not validated server side, so
`(string & {})` admits reality while literal autocomplete survives. A nested object is not
nullable, because `setPath` materialises it.

**Runtime, `src/schema.ts`.** `toJsonSchema(schema)` returns the object to send:

1. no `'~standard'` key and no callable converter: send the object as is;
2. a callable `toJsonSchema()` or `toJSONSchema()` method: call it (arktype);
3. a `'~standard'` object with neither: throw `MillisecondsError`, code `invalid_schema`,
   message:
   `Pass a JSON Schema. zod: typed<z.infer<typeof S>>(z.toJSONSchema(S)). valibot: typed<v.InferOutput<typeof S>>(toJsonSchema(S)). arktype works directly.`

The zero-dependency rule forbids importing zod or valibot to convert a schema, so the SDK
names the one line that converts it. `typed<T>()` carries the type across that line.

### 5.8 The class

```ts
export declare class DecisionMachine {
  /** 'decision-machine-1'. Paths are `${baseUrl}/v1/${model}/<capability>`. */
  static readonly model: 'decision-machine-1'

  constructor(options?: ClientOptions)
  readonly baseUrl: string

  /** A copy with some options changed. It shares nothing mutable. */
  withOptions(options: Partial<ClientOptions>): DecisionMachine

  yesNo<const T extends Input, const S extends string | readonly string[]>(
    input: T,
    statements: S,
    options?: CallOptions & { when_true?: string; when_false?: string },
  ): Decision<Fan<T, S extends readonly string[]
    ? { -readonly [K in keyof S]: YesNoResult<S[K] & string> }
    : YesNoResult<S & string>>>

  classify<const T extends Input, const L extends Labels>(
    input: T, labels: L, options?: CallOptions,
  ): Decision<Fan<T, ClassifyResult<LabelOf<L>>>>

  classifyTree<const T extends Input, const N extends Tree>(
    input: T, tree: N, options?: CallOptions,
  ): Decision<Fan<T, ClassifyTreeResult<TreeLabels<N>, LeafLabels<N>>>>

  rate<const T extends Input, const S extends readonly string[]>(
    input: T, scale: S, options?: CallOptions,
  ): Decision<Fan<T, RateResult<S>>>

  answer<const T extends Input, const Q extends string | readonly string[]>(
    input: T, questions: Q, options?: CallOptions,
  ): Decision<Fan<T, Q extends readonly string[]
    ? { -readonly [K in keyof Q]: AnswerResult<Q[K] & string> }
    : AnswerResult<Q & string>>>

  extract<const T extends Input, const S extends ExtractSchema>(
    input: T, schema: S, options?: CallOptions,
  ): Decision<Fan<T, Extracted<SchemaOutput<S>>>>

  entities<const T extends Input, const E extends Labels>(
    input: T, types: E, options?: CallOptions,
  ): Decision<Fan<T, Entity<LabelOf<E>>[]>>

  verify<const T extends Input>(
    input: T,
    field: string | { name: string; description?: string },
    value: string | number,
    options?: CallOptions,
  ): Decision<Fan<T, VerifyResult>>

  /** Escape hatch. Your path, your body, your type, the SDK's auth, retries and errors. */
  post<R>(path: string, body: unknown, options?: CallOptions): Decision<R>
}
```

`post()` takes a path, not a capability name, so it reaches a future route outside
`/v1/decision-machine-1/`. That is the day an escape hatch earns its keep.

`verify` accepts a bare string field name. The SDK sends `{ name }`.

### 5.9 Transport

One function. Every method is two lines on top of it.

```ts
const RETRY = new Set(['rate_limit_exceeded', 'runner_error', 'overloaded', 'connection_error', 'timeout'])
// A 429, 502 or 529 whose body is not the JSON envelope (a Cloudflare edge page) maps by status, so it retries too.
const backoff = (n: number) => Math.random() * Math.min(500 * 2 ** n, 8_000)  // full jitter
```

* Retry on `429 rate_limit_exceeded` (sleep `retry-after` when present, capped at 60 s),
  `502 runner_error`, `529 overloaded`, and on a transport failure or timeout. Every
  capability is a pure function, so a retry is always safe.
* Never retry `400`, `401` or `429 insufficient_quota`. Retrying a spent quota on a timer is
  what wakes someone up.
* `maxRetries` defaults to 2 and is overridable per call. `maxRetries: 0` turns retries off.
* The timeout is per attempt. `AbortSignal.timeout` composes with the caller's `signal`
  through `AbortSignal.any`. A runtime without `AbortSignal.any` falls back to one
  `AbortController` plus `setTimeout`.
* `user-agent: cloudraker-milliseconds-js/<version>`.
* The request body is built from what the caller sent. `Array.isArray(input)` chooses `texts`
  over `text`. The batch shape follows the **request**, never the response, so the `yes-no`
  quirk cannot produce a shape the type lies about.

---

## 6. The Python surface

PyPI `cloudraker-milliseconds`, import name `milliseconds`. The PyPI name `milliseconds`
belongs to an unrelated timestamp utility. Python >= 3.10. One runtime dependency: `httpx`.
Built with `uv` and hatchling.

### 6.1 The honest statement, first section of the README

Python has no mapped types and no conditional return types. It cannot read your label names
out of a dict display. It **can** solve a `TypeVar` from an annotated constant, so one
annotation buys the whole chain:

```python
from typing import Final, Literal, Mapping

Intent = Literal["billing", "shipping", "account"]

LABELS: Final[Mapping[Intent, str]] = {
    "billing": "payments, invoices, charges and refunds",
    "shipping": "delivery, tracking and packages",
    "account": "login, passwords and profile settings",
}

r = dm.classify(ticket, LABELS)   # ClassifyResult[Intent]
r.label                           # Intent. A match statement over it is exhaustive.
r.scores["billing"]               # ok. r.scores["refunds"] is a type error.
```

Without the annotation you get `ClassifyResult[str]`. Nothing breaks. You lose only the
names. The house style already keeps every label set in one file, so the annotation lands
where the constants already live.

`classify_tree` returns `label: str`. Recursive literal extraction from a nested dict has no
Python expression. The docstring says so.

### 6.2 Clients

```python
class DecisionMachine:
    model: ClassVar[str] = "decision-machine-1"

    def __init__(
        self,
        api_key: str | None = None,          # falls back to os.environ["MS_API_KEY"]
        *,
        base_url: str = "https://api.milliseconds.ai",
        timeout: float = 60.0,
        max_retries: int = 2,
        headers: Mapping[str, str] | None = None,
        http_client: httpx.Client | None = None,   # bring your own pool, proxy or transport
    ) -> None: ...

    def close(self) -> None: ...
    def __enter__(self) -> Self: ...
    def __exit__(self, *exc: object) -> None: ...


class AsyncDecisionMachine:
    """The same surface. Every capability is `async def`. It takes an httpx.AsyncClient."""
    async def aclose(self) -> None: ...
    async def __aenter__(self) -> Self: ...
    async def __aexit__(self, *exc: object) -> None: ...
```

Both clients share `_transport.py`, so retries, error parsing and header parsing cannot
drift.

### 6.3 Capabilities

Method names are `snake_case`. `str` is itself a `Sequence[str]`, so the `str` overload comes
first and the runtime branch is `isinstance(text, str)`. A reorder changes the inferred type
with no runtime failure, so `tests/test_types.py` pins all four `yes_no` shapes with
`assert_type`.

```python
L = TypeVar("L", bound=str)      # label, entity type, scale level
T = TypeVar("T")

class Results(list[T]):
    """A plain list, plus the usage of the one call that produced it."""
    usage: Usage

class CallOpts(TypedDict, total=False):
    timeout: float
    max_retries: int
    headers: Mapping[str, str]
```

```python
    @overload
    def yes_no(self, text: str, statements: str, *, when_true: str | None = None,
               when_false: str | None = None, **opts: Unpack[CallOpts]) -> YesNoResult: ...
    @overload
    def yes_no(self, text: str, statements: Sequence[str], *, when_true: str | None = None,
               when_false: str | None = None, **opts: Unpack[CallOpts]) -> Results[YesNoResult]: ...
    @overload
    def yes_no(self, text: Sequence[str], statements: str, *, when_true: str | None = None,
               when_false: str | None = None, **opts: Unpack[CallOpts]) -> Results[YesNoResult]: ...
    @overload
    def yes_no(self, text: Sequence[str], statements: Sequence[str], *, when_true: str | None = None,
               when_false: str | None = None, **opts: Unpack[CallOpts]) -> Results[Results[YesNoResult]]: ...

    @overload
    def classify(self, text: str, labels: Sequence[L] | Mapping[L, str],
                 **opts: Unpack[CallOpts]) -> ClassifyResult[L]: ...
    @overload
    def classify(self, text: Sequence[str], labels: Sequence[L] | Mapping[L, str],
                 **opts: Unpack[CallOpts]) -> Results[ClassifyResult[L]]: ...

    @overload
    def classify_tree(self, text: str, tree: Tree, **opts: Unpack[CallOpts]) -> ClassifyTreeResult: ...
    @overload
    def classify_tree(self, text: Sequence[str], tree: Tree,
                      **opts: Unpack[CallOpts]) -> Results[ClassifyTreeResult]: ...

    @overload
    def rate(self, text: str, scale: Sequence[L], **opts: Unpack[CallOpts]) -> RateResult[L]: ...
    @overload
    def rate(self, text: Sequence[str], scale: Sequence[L],
             **opts: Unpack[CallOpts]) -> Results[RateResult[L]]: ...

    @overload
    def answer(self, text: str, questions: str, **opts: Unpack[CallOpts]) -> AnswerResult: ...
    @overload
    def answer(self, text: str, questions: Sequence[str],
               **opts: Unpack[CallOpts]) -> Results[AnswerResult]: ...
    @overload
    def answer(self, text: Sequence[str], questions: str,
               **opts: Unpack[CallOpts]) -> Results[AnswerResult]: ...
    @overload
    def answer(self, text: Sequence[str], questions: Sequence[str],
               **opts: Unpack[CallOpts]) -> Results[Results[AnswerResult]]: ...

    # extract: the schema decides the return type
    @overload
    def extract(self, text: str, schema: type[T], **opts: Unpack[CallOpts]) -> T: ...
    @overload
    def extract(self, text: str, schema: Mapping[str, Any],
                **opts: Unpack[CallOpts]) -> dict[str, Any]: ...
    @overload
    def extract(self, text: Sequence[str], schema: type[T],
                **opts: Unpack[CallOpts]) -> Results[T]: ...
    @overload
    def extract(self, text: Sequence[str], schema: Mapping[str, Any],
                **opts: Unpack[CallOpts]) -> Results[dict[str, Any]]: ...

    @overload
    def entities(self, text: str, types: Sequence[L] | Mapping[L, str],
                 **opts: Unpack[CallOpts]) -> Results[Entity[L]]: ...
    @overload
    def entities(self, text: Sequence[str], types: Sequence[L] | Mapping[L, str],
                 **opts: Unpack[CallOpts]) -> Results[Results[Entity[L]]]: ...

    @overload
    def verify(self, text: str, field: str | Field, value: str | float,
               **opts: Unpack[CallOpts]) -> VerifyResult: ...
    @overload
    def verify(self, text: Sequence[str], field: str | Field, value: str | float,
               **opts: Unpack[CallOpts]) -> Results[VerifyResult]: ...

    # escape hatch
    def post(self, path: str, body: Mapping[str, Any], **opts: Unpack[CallOpts]) -> Any: ...
```

No `with_response` keyword. It would double 18 overloads to 36 for information that a
`.usage` attribute already carries.

### 6.4 Models

```python
@dataclass(frozen=True, slots=True)
class RateLimit:
    limit_requests: int
    remaining_requests: int
    reset_requests: str          # '5m0s'
    limit_tokens: int
    remaining_tokens: int
    reset_tokens: str

@dataclass(frozen=True, slots=True)
class Usage:
    input_chars: int
    input_tokens: int
    inference_ms: int
    rate_limit: RateLimit | None
    headers: Mapping[str, str]

@dataclass(frozen=True, slots=True)
class YesNoResult:
    statement: str
    answer: bool
    probability: float
    usage: Usage = field(repr=False, compare=False)

@dataclass(frozen=True, slots=True)
class ClassifyResult(Generic[L]):
    label: L
    probability: float
    confidence: float
    scores: Mapping[L, float]
    usage: Usage = field(repr=False, compare=False)

@dataclass(frozen=True, slots=True)
class ClassifyTreeLevel:
    label: str
    probability: float
    confidence: float
    scores: Mapping[str, float]
    input_chars: int
    input_tokens: int
    inference_ms: int

@dataclass(frozen=True, slots=True)
class ClassifyTreeResult:
    path: Sequence[str]
    label: str
    probability: float
    confidence: float
    levels: Sequence[ClassifyTreeLevel]
    usage: Usage = field(repr=False, compare=False)

@dataclass(frozen=True, slots=True)
class RateResult(Generic[L]):
    score: float
    level: int
    label: L
    confidence: float
    scores: Sequence[float]
    usage: Usage = field(repr=False, compare=False)

@dataclass(frozen=True, slots=True)
class AnswerResult:
    question: str
    answer: str | None
    probability: float
    start: int | None
    end: int | None
    usage: Usage = field(repr=False, compare=False)

    @property
    def span(self) -> tuple[int, int] | None:
        """(start, end) when the model found a span, else None. Python cannot narrow
        three fields from one check, so read the span through this."""

@dataclass(frozen=True, slots=True)
class Entity(Generic[L]):
    type: L
    text: str
    probability: float
    start: int
    end: int

@dataclass(frozen=True, slots=True)
class VerifyResult:
    matches: bool
    probability: float
    found: Sequence[str]
    usage: Usage = field(repr=False, compare=False)

class Field(TypedDict):
    name: str
    description: NotRequired[str]

class TreeNode(TypedDict):
    description: NotRequired[str]
    labels: NotRequired["Tree"]

Tree: TypeAlias = Mapping[str, "str | TreeNode"]
```

`usage` is a real field. Python has no spread operator that would silently drop it.
`repr=False, compare=False` keeps `print(r)` and `r == expected` clean. `Results.usage`
covers a batch.

**Every result is built through one filtered constructor**:

```python
def _build(cls, body, usage):
    names = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in body.items() if k in names}, usage=usage)
```

The API promises additive changes. Without the filter a new response field raises
`TypeError` in production.

### 6.5 Errors

```python
class MillisecondsError(Exception):
    code: str
    status: int | None          # None for a transport failure
    api_message: str
    retry_after: float | None
    rate_limit: RateLimit | None
    response: httpx.Response | None
    attempts: int
    retryable: bool

class InvalidRequestError(MillisecondsError): ...   # 400 invalid_request / invalid_schema, and client_error
class AuthenticationError(MillisecondsError): ...   # 401
class RateLimitError(MillisecondsError): ...        # 429 rate_limit_exceeded
class QuotaExceededError(MillisecondsError): ...    # 429 insufficient_quota. Never retried.
class RunnerError(MillisecondsError): ...           # 502
class OverloadedError(MillisecondsError): ...       # 529
class ConnectionError(MillisecondsError): ...       # no response
```

Python users write `except RateLimitError:`. TypeScript users switch on `e.code`. Each
language keeps its own habit. The retry policy, the backoff, the messages and the
client-side checks are identical in both SDKs.

### 6.6 Extraction in Python

`_schema.py` turns the argument into a JSON Schema at runtime:

1. an object with `model_json_schema()` (pydantic v2): called by duck typing, never imported;
2. a `TypedDict` or a dataclass: walked with `typing.get_type_hints`, supporting `str`,
   `int`, `float`, `bool`, `Literal[...]`, `list[str]`, nested TypedDicts and `X | None`;
3. a plain `dict`: sent as is.

```python
from typing import Literal, TypedDict

class Invoice(TypedDict):
    invoice_number: str | None
    total: float | None
    currency: Literal["USD", "EUR"] | None

data = dm.extract(pdf_text, Invoice)     # Invoice
data["total"]                            # float | None
```

**Declare every field `| None`.** Missing values come back as `None`. Arrays of objects come
back as `[]`. Arrays of scalars come back as lists of strings. Python cannot rewrite your
type the way `Extracted<T>` does in TypeScript, so the converter raises at schema-build time
when a field is not optional, and every example declares `| None`.

---

## 7. Inferred types

Eight examples. The comment is the hover text.

### 7.1 classify — your label union

```ts
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
if (r.label === 'refunds') never()   // error: this comparison has no overlap
```

### 7.2 A tuple of texts gives a tuple of results

```ts
const [a, b, c] = await dm.classify([t1, t2, t3], LABELS)
// result: [ClassifyResult<'billing'|'shipping'|'account'>,
//          ClassifyResult<'billing'|'shipping'|'account'>,
//          ClassifyResult<'billing'|'shipping'|'account'>]
// destructuring a fourth element is a compile error

const many = await dm.classify(tickets, LABELS)   // tickets: string[]
// many: ClassifyResult<'billing' | 'shipping' | 'account'>[]
```

### 7.3 yes-no — statements map positionally

```ts
const [urgent, shipping] = await dm.yesNo(ticket, [
  'The customer expresses urgency.',
  'The customer is asking about shipping.',
], { when_true: 'Time pressure, ASAP, losing money' })
// urgent:   YesNoResult<'The customer expresses urgency.'>
// shipping: YesNoResult<'The customer is asking about shipping.'>
// urgent.statement: 'The customer expresses urgency.'   the literal, not string

const grid = await dm.yesNo(passages, ['The passage answers the question.'])
// grid: [YesNoResult<'The passage answers the question.'>][]
```

### 7.4 rate — level, label and a fixed-length scores tuple

```ts
const r = await dm.rate(message, ['Calm', 'Annoyed', 'Angry', 'Threatening to leave'])
// r: RateResult<readonly ['Calm','Annoyed','Angry','Threatening to leave']>
// r.label:  'Calm' | 'Annoyed' | 'Angry' | 'Threatening to leave'
// r.level:  0 | 1 | 2 | 3
// r.scores: [number, number, number, number]
// r.score:  number
if (r.score > 2.5) escalate()   // route on score, never on level
```

### 7.5 extract from a JSON Schema literal

```ts
const data = await dm.extract(letter, {
  type: 'object',
  properties: {
    due_date: { description: 'the date the payment is due' },
    total: { type: 'number' },
    paid: { type: 'boolean' },
    reference: { type: 'string', enum: ['AB', 'CD'] },
    tags: { type: 'array', items: { type: 'string' } },
    amounts: { type: 'array', items: { type: 'number' } },
    line_items: { type: 'array', items: { type: 'object' } },
    vendor: { type: 'object', properties: { name: { type: 'string' } } },
    when: { type: 'null' },
  },
})
// data: {
//   due_date:   string | null                            no `type` is a string
//   total:      number | null
//   paid:       boolean | null
//   reference:  'AB' | 'CD' | (string & {}) | null       no server-side enum check
//   tags:       string[] | null
//   amounts:    string[] | null                          coerce stringifies every element
//   line_items: never[]                                  always empty, never null
//   vendor:     { name: string | null }                  the object itself is never null
//   when:       undefined                                the key never appears
// }
```

### 7.6 extract with zod 4

```ts
import { z } from 'zod'
import { typed } from '@cloudraker/milliseconds'

const Invoice = z.object({
  invoice_number: z.string().describe('the identifier printed on the invoice'),
  total: z.number().describe('the amount due including tax'),
  currency: z.enum(['USD', 'EUR', 'GBP']),
  line_items: z.array(z.object({ sku: z.string() })),
})

const data = await dm.extract(pdfText, typed<z.infer<typeof Invoice>>(z.toJSONSchema(Invoice)))
// data: {
//   invoice_number: string | null
//   total:          number | null
//   currency:       'USD' | 'EUR' | 'GBP' | (string & {}) | null
//   line_items:     never[]
// }
if (data.total !== null && data.total > 10_000) review()
```

An arktype schema passes straight in: `dm.extract(text, Invoice)`. The SDK calls its
`toJsonSchema()` and types the result from `~standard.types.output`.

### 7.7 classify-tree — two different unions

```ts
const r = await dm.classifyTree(ticket, {
  billing: {
    description: 'payments, invoices, charges, refunds and subscriptions',
    labels: {
      refund_request: 'the customer asks for money back',
      subscription_change: 'the customer wants to upgrade, downgrade or cancel a plan',
    },
  },
  shipping: 'delivery, tracking, lost or damaged parcels',
})
// r.label: 'refund_request' | 'subscription_change' | 'shipping'   a walk stops here
// r.path:  ('billing' | 'shipping' | 'refund_request' | 'subscription_change')[]
// r.levels[0].input_tokens: number        wire name kept
// r.levels[0].scores: Record<string, number>
```

### 7.8 answer — the null case narrows

```ts
const [who, cost] = await dm.answer(article, [
  'Who announced the product?',
  'How much does it cost?',
])
// who:  AnswerResult<'Who announced the product?'>
// cost: AnswerResult<'How much does it cost?'>
if (who.answer !== null) {
  article.slice(who.start, who.end)   // start: number, end: number. No non-null assertion.
}
article.slice(cost.start, cost.end)   // error: start is number | null before the check
```

---

## 8. Client-side checks

### 8.1 The table

Both SDKs run these before any HTTP call. They throw `MillisecondsError` with `status: 0` and
code `client_error` (`InvalidRequestError` in Python). Two of them shield the user from a
documented API trap.

| Check | Message |
| --- | --- |
| no `apiKey` and no `MS_API_KEY` | `No API key. Pass new DecisionMachine({ apiKey }) or set MS_API_KEY. Get a key at https://console.milliseconds.ai.` |
| an empty input array | `texts is empty. Send at least one text.` |
| over 32 texts | `texts has 41 items. The limit is 32. Split the batch.` |
| a text over 20,000 characters | `texts[3] is 24,110 characters. The limit is 20,000. Split on paragraphs and send the parts as texts.` |
| an empty text, or an empty element in texts | `text is empty. Send at least one character.` / `texts[1] is empty. Send at least one character.` |
| `yes-no` with no statement | `yes-no needs a statement. The wire message for a body without one names both fields and misleads.` |
| a bare string where a list belongs (Python) | `labels is a string. A string sends one entry per letter. Send a list.` |
| an empty statements or questions array, or over 32 | `statements has 0 items. Send 1 to 32.` |
| fewer than 2 or more than 64 labels | `labels has 1 entry. classify needs 2 to 64.` |
| fewer than 1 or more than 64 entity types | `types is empty. entities needs 1 to 64.` |
| fewer than 2 or more than 10 scale levels | `scale has 12 entries. rate needs 2 to 10.` |
| an extract schema that is not an object with properties | `The schema must be an object with properties.` |
| a browser without `dangerouslyAllowBrowser` | `The API key is a secret. Call the API from your server, or pass dangerouslyAllowBrowser: true when the bundle never reaches a user.` |

The label check never fires on `entities`, because the two minimums differ in
`decide.schema.ts`. One shared rule would reject a legal single-type `entities` call.

### 8.2 Error message copy

The thrown `message` is the API message plus one hint line. `apiMessage` keeps the wire text
for a log.

```
MillisecondsError: milliseconds rejected the request (400 invalid_request):
labels: Too small: expected array to have >=2 items
  classify needs two or more labels. Describe each one. Described labels score
  measurably better than bare names.

MillisecondsError: milliseconds rejected the API key (401 invalid_api_key).
Keys start with "sk-ms-". Check MS_API_KEY, or create a key at
https://console.milliseconds.ai.

MillisecondsError: rate limited (429 rate_limit_exceeded) after 3 attempts over 7.2s:
Rate limit reached for requests on this organization. Retry after 4s.
  Lower your concurrency, or raise maxRetries. Limits are per organization and
  shared by every key.

MillisecondsError: no token credits left (429 insufficient_quota): Your organization
has no Milliseconds token credits left. Add credits in the console at
https://console.milliseconds.ai.
  Not retried. A timer retry will not help.

MillisecondsError: every inference slot stayed busy (529 overloaded) after 3 attempts
over 9.4s.
  This is backpressure, not a fault. Send fewer texts per call, or back off further.
  A texts batch of 32 asks for 32 slots at once.
```

---

## 9. What the SDK changes, and nothing else

Both READMEs carry this table. `dm1 --raw` and `dm.post()` reach the untouched body.

| Wire | SDK | Why |
| --- | --- | --- |
| `{ results: [...] }` | a plain array | one envelope less. The order is already guaranteed. |
| `{ entities: [...] }` | a plain array | the same |
| `{ data: {...} }` | the object itself | the same |
| `text` / `texts` | one positional `input` | the mutual exclusion becomes impossible |
| `statement` / `statements` | one positional argument | the same |
| `question` / `questions` | one positional argument | the same |
| `x-*` headers | `withUsage()`, `.usage` | the headers stay reachable, the results stay clean |

Every other field keeps its exact wire name.

---

## 10. dm1

`dm1` ships as the `bin` of `@cloudraker/milliseconds`. It imports the TypeScript SDK, so the
auth, the retries, the client-side checks and the error messages are the SDK's. Zero runtime
dependencies: `node:util` `parseArgs`, global `fetch`, `node:readline`. Node >= 20.

`dist/cli.js` is a second entry point. It must never be reachable from the library entry
point, or a bundler pulls `node:util` into a browser or Workers build. A bundle test asserts
that no `node:` specifier survives an import of the library alone.

### 10.1 Key storage

There is none. `dm1` reads `MS_API_KEY`, or takes `--key`. It writes no file, keeps no
config and caches no token. `MS_API_KEY` is the name the docs, the skills and both SDKs
already use.

`--key` lands in the shell history and in `ps`, so the help text recommends the environment
variable, `direnv` or `op run --`.

### 10.2 `dm1 --help`

```
dm1 — typed decisions over text, from milliseconds.ai

USAGE
  dm1 <capability> [text] [args...] [options]
  <command> | dm1 <capability> [args...]

CAPABILITIES
  classify       <text> <label[=description]>...   Pick one label
  yes-no         <text> <statement>...             True or false, per statement
  rate           <text> <level>...                 Place the text on a low-to-high scale
  answer         <text> <question>...              Quote the answer out of the text
  entities       <text> <type[=description]>...    Find every mention, with offsets
  extract        <text> --schema <file|json>       Fill a JSON Schema
  verify         <text> --field <name> --value <v> Check a value against the text
  classify-tree  <text> --tree <file|json>         Walk a nested label tree
  check                                            Test the key. Print the limits.

TEXT
  [text]              The text itself. Omit it, or pass -, to read stdin.
  -f, --file <path>   Read the text from a file. Repeat it for a batch, in order.
  --lines <path>      One text per line. Sent in chunks of 32, in order.
  Piped input that starts with { becomes the whole request body. Flags still win.

SPECIFICATION
  A positional after the text is a label, statement, level, question or type.
  name=description splits on the first =. A bare name has no description.
  Any list also loads from a file: @labels.json holds an array or a name-to-description object.
  --tree @taxonomy.json   --schema @invoice.json   @- reads stdin.
  --when-true <s> --when-false <s>     yes-no hints
  --field <name[=description]> --value <v>   verify

OPTIONS
  --json              Print JSON, even on a terminal.
  --jsonl             One compact JSON result per line. For pipes.
  --raw               Print the API response exactly as it arrived.
  -q, --quiet         Print the primary value only.
  --check             yes-no and verify only. Exit 3 when the answer is no.
  --min <p>           Exit 3 when probability is below <p>.
  --min-confidence <c>  Exit 3 when confidence is below <c>.
  --key <key>         API key. Default: $MS_API_KEY.
  --base-url <url>    Default: https://api.milliseconds.ai
  --retries <n>       Retries on 429, 502, 529 and network errors. Default 2.
  --timeout <ms>      Per attempt. Default 60000.
  -v, --usage         Print tokens, model time and rate limits to stderr.
  --no-color          No ANSI. NO_COLOR and a non-TTY stdout do the same.
  -h, --help          This text. After a capability, that capability's help.
  -V, --version

DESCRIBE YOUR LABELS
  The label text is the instruction. The model reads it literally.
    dm1 classify "$T" billing shipping                     works
    dm1 classify "$T" billing="charges and refunds" shipping="delivery and tracking"
  The second call scores measurably better. Use name=description everywhere.

EXIT CODES
  0  decided          2  bad usage
  1  API error        3  --check or --min failed

EXAMPLES
  dm1 classify "I was charged twice" billing shipping account
  dm1 yes-no "Ship it today" "The customer expresses urgency." --check
  dm1 rate "This is unacceptable" Calm Annoyed Angry "Threatening to leave"
  dm1 entities "Ada met Grace in Paris" person place --json | jq -r '.[].text'
  dm1 extract -f invoice.txt --schema @invoice.json
  dm1 classify --lines tickets.txt billing shipping account --jsonl > labelled.ndjson
  pbpaste | dm1 classify

  No key yet?  https://console.milliseconds.ai  then  export MS_API_KEY=sk-ms-...
```

### 10.3 Subcommand help

Every subcommand help opens with the same three lines: the usage line, one sentence on what
the capability returns, and the API path.

```
dm1 classify --help

  dm1 classify [text] <label[=description]>... [options]

  Picks one label and returns the full distribution.
  POST /v1/decision-machine-1/classify

  ARGUMENTS
    [text]                  The text. Omit it, or pass -, to read stdin.
    <label[=description]>   2 to 64 labels. Describe each one for better accuracy.
                            @labels.json loads an array or a name-to-description object.

  RESULT
    label, probability, confidence, scores

  PREDICATES
    --min <p>               Exit 3 when probability is below p.
    --min-confidence <c>    Exit 3 when confidence is below c.

  EXAMPLES
    dm1 classify "I was charged twice." billing="charges and refunds" shipping="delivery"
    dm1 classify -f ticket.txt @labels.json --json
    dm1 classify --lines tickets.txt @labels.json --jsonl | jq -r '.label'
    cat ticket.txt | dm1 classify @labels.json --min 0.9 -q
```

```
dm1 yes-no --help

  dm1 yes-no [text] <statement>... [options]

  Answers each statement with yes or no and a probability.
  POST /v1/decision-machine-1/yes-no

  ARGUMENTS
    [text]          The text. Omit it, or pass -, to read stdin.
    <statement>     1 to 32 third-person claims about the text. They share one
                    inference call, so extra statements are nearly free.

  FLAGS
    --when-true <s>   What makes the statement true. It improves accuracy.
    --when-false <s>  What makes it false.
    --check           Exit 3 when the answer is no. In a batch, any no fails the run.

  RESULT
    statement, answer, probability

  EXAMPLES
    dm1 yes-no "Fix this today." "The customer expresses urgency."
    dm1 yes-no -f reply.txt "The reply promises a refund." --check --min 0.9 -q
    dm1 yes-no -f a.txt -f b.txt "The text mentions a price." --jsonl
```

```
dm1 rate --help

  dm1 rate [text] <level>... [options]

  Places the text on an ordered scale of described levels.
  POST /v1/decision-machine-1/rate

  ARGUMENTS
    [text]      The text. Omit it, or pass -, to read stdin.
    <level>     2 to 10 level descriptions, low to high, in order. Never numbers.

  RESULT
    score, level, label, confidence, scores
    Route on score and confidence. level flips on 0.001.

  EXAMPLES
    dm1 rate "I am done with this company." Calm Annoyed Angry "Threatening to leave"
    dm1 rate -f email.txt @scale.json --usage
```

```
dm1 answer --help

  dm1 answer [text] <question>... [options]

  Quotes the answer out of the text, with its offsets.
  POST /v1/decision-machine-1/answer

  ARGUMENTS
    [text]        The text. Omit it, or pass -, to read stdin.
    <question>    1 to 32 questions. They share one inference call.
                  Name the role, not the type: "the date the payment is due".

  RESULT
    question, answer, probability, start, end
    answer is null when nothing fits. start and end are then null too.
    Offsets index the text at the same position in the batch, never a joined string.

  EXAMPLES
    dm1 answer -f press.txt "Who announced the product?" "How much does it cost?"
    curl -s https://example.com/press.txt | dm1 answer - "Who announced the product?"
```

```
dm1 entities --help

  dm1 entities [text] <type[=description]>... [options]

  Finds every span matching each type, with offsets.
  POST /v1/decision-machine-1/entities

  ARGUMENTS
    [text]                 The text. Omit it, or pass -, to read stdin.
    <type[=description]>   1 to 64 entity types. Describe each one.

  RESULT
    A list of { type, text, probability, start, end }, sorted by start.

  EXAMPLES
    dm1 entities "Ada met Grace in Paris." person="a human name" place="a city or country"
    pbpaste | dm1 entities @types.json --json | jq -r '.[] | select(.type=="person") | .text'
```

```
dm1 extract --help

  dm1 extract [text] --schema <file|json> [options]

  Fills a JSON Schema from the text.
  POST /v1/decision-machine-1/extract

  FLAGS
    --schema @invoice.json   The JSON Schema. @- reads stdin. Inline JSON works too.

  RESULT
    The data object. Missing values are null. Arrays of objects come back empty.
    Arrays of scalars come back as strings. Enums are not checked server side.

  EXAMPLES
    dm1 extract -f invoice.txt --schema @invoice.json --json > invoice.json
    dm1 extract -f a.txt -f b.txt --schema @invoice.json --jsonl
```

```
dm1 verify --help

  dm1 verify [text] --field <name[=description]> --value <v> [options]

  Checks whether the text says <v> for <field>.
  POST /v1/decision-machine-1/verify

  FLAGS
    --field <name[=description]>   The field to read out of the text.
    --value <v>                    The value you already hold.
    --check                        Exit 3 when the value does not match.

  RESULT
    matches, probability, found
    found shows what the text actually says.

  EXAMPLES
    dm1 verify -f invoice.txt --field invoice_number="the identifier printed on the invoice" \
      --value 4471 --check
    dm1 verify -f invoice.txt --field total --value 999 --json | jq .found
```

```
dm1 classify-tree --help

  dm1 classify-tree [text] --tree <file|json> [options]

  Runs classify once per level of a nested tree, descending into the winner.
  POST /v1/decision-machine-1/classify-tree

  FLAGS
    --tree @taxonomy.json   name -> description, or name -> { description, labels }.
                            2 to 64 labels per level, at most 8 levels.

  RESULT
    path, label, probability, confidence, levels[]
    probability and confidence are products over the levels, so they fall with depth.
    Each level re-sends the text, so the per-level input numbers do not sum to the
    x-input-chars header.

  EXAMPLES
    dm1 classify-tree -f ticket.txt --tree @taxonomy.json --json
    dm1 classify-tree "I want my money back." --tree @taxonomy.json -q
```

```
dm1 check --help

  dm1 check [options]

  Tests the key and prints the limits. It sends one small classify, about 20 tokens.
  Do not run it in a health-check loop.

  EXAMPLES
    dm1 check
    dm1 check --base-url https://api.milliseconds.ai --key sk-ms-...
```

### 10.4 Conventions

**Input.** One source only. The precedence is the positional text, then `--file`, then
`--lines`, then stdin when it is a pipe. No source and a TTY on stdin is a usage error.
Piped input that starts with `{` after trimming becomes the whole request body, and flags
still override single keys. That makes every curl body in the docs runnable with
`pbpaste | dm1 classify`. A parse failure on such input exits 2 and names both recoveries.

**Specification.** After the text, every positional is the capability's list argument. The
parser splits `name=description` on the first `=`. `@path` loads a JSON array or a
name-to-description object, which keeps a label set in one reviewable file.

**Output.** A terminal gets an aligned table. A pipe gets JSON, so `| jq` works with no
flag. `--json` forces JSON on a terminal. `--jsonl` prints one compact object per line, one
line per text, with the input `text` added so the batch stays joinable. `--raw` prints the
API body, envelope and all. `-q` prints the primary value only.

**Batching.** `--lines` and repeated `--file` chunk at 32 and send the chunks in order.
`--usage` reports the sum. A chunk that fails after earlier chunks printed leaves partial
output, and the error message says which chunk failed.

**Exit codes.** `0` a decision came back. `1` the API refused or the network failed after
retries. `2` the arguments or stdin were wrong, and nothing was sent. `3` a `--check` or
`--min` predicate failed, and the result still printed.

**Streams.** stdout holds results only. Usage and errors go to stderr. An error prints as
`dm1: <code>: <message>`.

### 10.5 Worked output

```console
$ dm1 classify "I was charged twice for my subscription." \
    billing="payments, invoices, charges or refunds" \
    shipping="delivery, tracking or returns" \
    account="login, password or profile settings"
label        billing
probability  0.999
confidence   0.995

scores
  billing    0.999  ████████████████████
  account    0.001
  shipping   0.000
```

```console
$ dm1 classify "I was charged twice." billing shipping account
label        billing
probability  0.956
confidence   0.833
...
  Bare label names score worse. Try: billing="charges and refunds"
```

The hint prints only when every label was bare, only on a terminal, and only once per run.

```console
$ dm1 classify --lines tickets.txt @labels.json --jsonl | jq -r '.label'
billing
shipping
account
```

```console
$ echo "I am done with this company." | dm1 rate Calm Annoyed Angry "Threatening to leave" -v
{"score":2.61,"level":3,"label":"Threatening to leave","confidence":0.74,"scores":[0.01,0.08,0.31,0.6]}
usage: 79 chars, 20 tokens, 381 ms inference, 199/200 requests left
```

```console
$ dm1 yes-no -f reply.txt "The reply promises a refund." --check --min 0.9 -q
no
$ echo $?
3
```

```console
$ dm1 check
key        sk-ms-01KMRZ…V7ta   valid
endpoint   https://api.milliseconds.ai
latency    212 ms round trip · 41 ms model
limits     200 req/min  ·  1,000,000 tok/min
remaining  199 req      ·  999,980 tok
ok
```

```console
$ dm1 classify "I was charged twice." billing
dm1: client_error: labels has 1 entry. classify needs 2 to 64.

  dm1 classify "I was charged twice." billing shipping account
$ echo $?
2
```

Nothing was sent, so no token was billed.

---

## 11. Build and packaging

### 11.1 typescript/package.json

```jsonc
{
  "name": "@cloudraker/milliseconds",
  "version": "0.1.0",
  "description": "Typed decisions over text. The SDK for decision-machine-1 at milliseconds.ai.",
  "license": "MIT",
  "author": "CloudRaker",
  "homepage": "https://docs.milliseconds.ai",
  "repository": { "type": "git", "url": "git+https://github.com/CloudRaker/milliseconds-sdk.git", "directory": "typescript" },
  "bugs": "https://github.com/CloudRaker/milliseconds-sdk/issues",
  "keywords": ["milliseconds", "decision-machine-1", "classification", "extraction", "nlp", "llm"],
  "type": "module",
  "engines": { "node": ">=20" },
  "sideEffects": false,
  "bin": { "dm1": "./dist/cli.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./package.json": "./package.json"
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "peerDependencies": { "typescript": ">=5.0" },
  "peerDependenciesMeta": { "typescript": { "optional": true } },
  "dependencies": {},
  "devDependencies": { "tsdown": "^0.15", "typescript": "^5.9", "vitest": "^4", "oxlint": "^1", "oxfmt": "^0.1" },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint src test",
    "format": "oxfmt src test",
    "prepublishOnly": "pnpm build"
  }
}
```

`tsdown.config.ts`: two entries, `src/index.ts` and `src/cli/index.ts` (output `cli.js`),
formats `esm` and `cjs`, `dts: true`, `platform: 'neutral'` for the library entry and
`'node'` for the CLI, a `#!/usr/bin/env node` banner on the CLI.

`tsconfig.json`: `"strict": true`, `"target": "ES2022"`, `"module": "preserve"`,
`"moduleResolution": "bundler"`, `"lib": ["ES2022", "DOM"]`, `"verbatimModuleSyntax": true`.

### 11.2 python/pyproject.toml

```toml
[project]
name = "cloudraker-milliseconds"
version = "0.1.0"
description = "Typed decisions over text. The SDK for decision-machine-1 at milliseconds.ai."
readme = "README.md"
license = "MIT"
requires-python = ">=3.10"
authors = [{ name = "CloudRaker" }]
keywords = ["milliseconds", "decision-machine-1", "classification", "extraction", "nlp"]
classifiers = [
  "Programming Language :: Python :: 3.10",
  "Programming Language :: Python :: 3.11",
  "Programming Language :: Python :: 3.12",
  "Programming Language :: Python :: 3.13",
  "Typing :: Typed",
]
dependencies = ["httpx>=0.27"]

[project.urls]
Homepage = "https://milliseconds.ai"
Documentation = "https://docs.milliseconds.ai"
Source = "https://github.com/CloudRaker/milliseconds-sdk"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/milliseconds"]

[dependency-groups]
dev = ["pytest>=8", "pytest-asyncio>=0.24", "pyright>=1.1.390", "ruff>=0.8", "respx>=0.21"]

[tool.pyright]
typeCheckingMode = "strict"
pythonVersion = "3.10"

[tool.pytest.ini_options]
asyncio_mode = "auto"
```

There is no console script. `dm1` is the npm package's bin, so one CLI implementation serves
both languages.

---

## 12. Tests

### 12.1 TypeScript

| File | What it pins |
| --- | --- |
| `test/types.test-d.ts` | `expectTypeOf` on every example of section 7, plus: `Fan` over a tuple and over `string[]`, `IndexOf` over both, `LeafLabels` against `TreeLabels`, `Extracted` on all nine property kinds of 7.5, `ErrorCode` narrowing in a `switch`. |
| `test/client.test.ts` | A stubbed `fetch`. It asserts the request body for `text` against `texts`, for `statement` against `statements`, the three envelope unwraps, `withUsage()` parsing of all nine headers, `withUsage()` with no rate-limit headers giving `rateLimit: null`, one 529 then 200, one 429 honouring `retry-after`, 400 not retried, `insufficient_quota` not retried, `attempts` on the thrown error, and a body that keeps an unknown extra field. |
| `test/validate.test.ts` | Every row of section 8.1, and that no `fetch` ran. |
| `test/cli.test.ts` | argv in, request body and stdout out, for every capability. It pins the `{` stdin passthrough, `--lines` chunking at 32, exit codes 2 and 3, and usage on stderr. |
| `test/live.test.ts` | `describe.skipIf(!process.env.MS_API_KEY)`. One call per capability against the live API. It asserts the shape, never the values. |

Type tests run against the supported TypeScript range in CI: 5.0, 5.4 and latest. The
`const P` plus recursive conditional types are load bearing and not formally guaranteed, so
a regression must fail CI, not a user's editor. A budget check runs
`tsc --extendedDiagnostics` over a worst case: an 8-level, 64-label tree and a 6-level,
40-field schema.

A bundle test imports the library entry point alone and asserts that no `node:` specifier
survives.

### 12.2 Python

| File | What it pins |
| --- | --- |
| `tests/test_client.py` | `httpx.MockTransport`. The same list as `client.test.ts`, for both the sync and the async client. Plus: an unknown response field does not raise. |
| `tests/test_types.py` | `assert_type` on all four `yes_no` shapes, all four `answer` shapes, `classify` with an annotated `Mapping[Intent, str]` and with a bare dict, `rate`, `entities`, and `extract` with a TypedDict. Pyright runs it in strict mode, and a failure is a test failure. |
| `tests/test_validate.py` | Every row of section 8.1. |
| `tests/test_live.py` | `pytest.mark.skipif(not os.environ.get("MS_API_KEY"))`. |

The overload order is the one Python trap: `str` is a `Sequence[str]`. `test_types.py` is
what catches a reorder.

---

## 13. READMEs

### 13.1 typescript/README.md

1. One paragraph: what `decision-machine-1` does, and what the SDK adds.
2. Install, then the classify example of 7.1, with the hover types in comments.
3. The line that sells it: `r.label === 'shiping'` is a compile error here.
4. The eight capabilities, one example each.
5. Batching: one text, a batch of texts, both axes.
6. Extraction: the JSON Schema literal path, then zod through `typed()`, then arktype. The
   four degradations, stated as a list.
7. Usage and rate limits through `withUsage()`. The trailing-gauge warning.
8. Errors and retries. The `switch` on `code`. What is never retried.
9. The mapping table of section 9.
10. Runtimes: Node, Bun, Deno, Workers, and the browser warning.
11. Gotchas: `yes-no` accepts a body the SDK forbids, and `classify-tree` per-level numbers
    do not sum to the header.
12. Links: docs.milliseconds.ai, the console, the Python package.

### 13.2 python/README.md

The same order, with two changes. Section 3 becomes the honest statement of 6.1, before any
other example. Section 6 states **declare every field `| None`** in the same sentence as the
example.

### 13.3 Repository README.md

Eight lines. What the repository holds, the two packages, the CLI, the install commands, and
a link to each package README.

---

## 14. GitHub Actions

### 14.1 .github/workflows/ci.yml

Triggers: `push` and `pull_request`.

```yaml
name: ci
on: [push, pull_request]
jobs:
  typescript:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: jdx/mise-action@v4
      - run: pnpm install --frozen-lockfile
        working-directory: typescript
      - run: pnpm lint
        working-directory: typescript
      - run: pnpm typecheck
        working-directory: typescript
      - run: pnpm test
        working-directory: typescript
      - run: pnpm build
        working-directory: typescript

  typescript-versions:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        typescript: ['5.0', '5.4', 'latest']
    steps:
      - uses: actions/checkout@v7
      - uses: jdx/mise-action@v4
      - run: pnpm install --frozen-lockfile
        working-directory: typescript
      - run: pnpm add -D typescript@${{ matrix.typescript }}
        working-directory: typescript
      - run: pnpm typecheck && pnpm vitest run --typecheck
        working-directory: typescript

  python:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python: ['3.10', '3.13']
    steps:
      - uses: actions/checkout@v7
      - uses: astral-sh/setup-uv@v5
      - run: uv sync --all-groups
        working-directory: python
      - run: uv run ruff check src tests
        working-directory: python
      - run: uv run pyright
        working-directory: python
      - run: uv run pytest
        working-directory: python
```

The live tests skip themselves, because `MS_API_KEY` is not set in CI. A nightly job may set
it from a repository secret.

### 14.2 .github/workflows/publish.yml

It mirrors `cloudraker-sdk/.github/workflows/publish.yml`: manual dispatch, an `npm_tag`
input, OIDC trusted publishing on both registries, and an explicit `contents: read` beside
`id-token: write` so checkout still works.

```yaml
# Publishes the SDKs to npm (@cloudraker/milliseconds) and PyPI
# (cloudraker-milliseconds). Manual dispatch only — bump the version in
# typescript/package.json and python/pyproject.toml first, commit, then run this.
#
# Release channel: `npm_tag` is the npm dist-tag. `latest` is a real release.
# `dev` publishes the version without moving `latest`. PyPI needs no equivalent:
# pip already excludes a PEP 440 prerelease (`0.2.0.devN`) unless `--pre` is passed.
#
# One-time setup (both registries use OIDC — no tokens):
# - npm: the FIRST publish must be done locally (`npm publish --access public`
#   from typescript/, logged in). npm only accepts a trusted publisher on an
#   existing package. Then package settings → Trusted Publisher → GitHub Actions:
#   CloudRaker / milliseconds-sdk / publish.yml, environment blank.
# - PyPI: a pending trusted publisher on the `cloudraker-milliseconds` project
#   pointing at this repo and publish.yml. It works before the first publish.
name: publish

on:
  workflow_dispatch:
    inputs:
      npm_tag:
        description: npm dist-tag (`latest` for a real release, `dev` for a prerelease)
        required: false
        default: latest

jobs:
  npm:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: jdx/mise-action@v4
      - run: pnpm install --frozen-lockfile
        working-directory: typescript
      - run: pnpm build
        working-directory: typescript
      # Never ship an empty package, and never ship a broken bin.
      - run: test -f typescript/dist/index.js && test -f typescript/dist/index.d.ts && test -f typescript/dist/cli.js
      - run: npm publish --access public --tag "${{ inputs.npm_tag || 'latest' }}"
        working-directory: typescript

  pypi:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v7
      - run: test -f python/src/milliseconds/_client.py
      - run: pipx run build python
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          packages-dir: python/dist
```

npm runs first. A failure after npm succeeded is fixed by a patch version, never by a
re-publish.

---

## 15. Known risks

Each risk names its mitigation. None of them blocks the first release.

1. **`const` type parameters plus recursive conditional types are load bearing.** The
   TypeScript matrix in CI is the guard. The fallback is plain overloads and worse error
   text, never a broken runtime.
2. **TypeScript 4.9 and older fail hard** on the `const` modifier. The README names 5.0 in
   its first section, and `peerDependencies` declares it.
3. **A deep tree or a large schema can slow the editor.** `LeafLabels` and `FromJsonSchema`
   carry the API's own limits: 8 levels and 64 labels. The type budget check in CI watches
   it. The escape is `dm.extract<Shape>(...)` with an explicit type argument.
4. **A tuple of 32 texts builds a 32-element tuple type.** A `string[]` argument, the normal
   case for a real workload, degrades to `R[]` at once.
5. **Python cannot infer label literals from a dict display.** The README says so in its
   first section, not in a footnote.
6. **Python `extract` returns the declared TypedDict while the runtime may return `None`.**
   The converter raises at schema-build time on a non-optional field, and every example
   declares `| None`.
7. **The unwrapped envelopes differ from every docs example.** The mapping table of section
   9 sits in both READMEs. `dm1 --raw` and `dm.post()` reach the raw body. The Fern docs
   should gain SDK tabs from the same examples.
8. **Both SDKs are hand written against `decide.schema.ts` with no generated link.** Add a
   CI check in `decision-machine` that diffs the exported OpenAPI result properties against
   a checked-in list here, and fails this repository's build on drift.
9. **Retrying transport failures can hide a wrong `baseUrl` behind three slow attempts.**
   `attempts` and the `connection_error` code make it visible. `maxRetries: 0` turns it off.
10. **`dm1 --lines` chunks sequentially with no resume.** A 10,000-line file is 313 round
    trips. `--jsonl` flushes partial results, and the error names the failed chunk. Add
    `--concurrency` when a user asks.
11. **`dm1 check` bills about 20 tokens.** The help text says so, and warns against a
    health-check loop.
12. **The rate-limit numbers trail reality** by one request per colo. The doc comment says
    so. Never build admission control on them.
13. **The SDK never estimates a cost.** Two token formulas exist in the sources. It reports
    `x-input-tokens` and nothing else.
