/**
 * Every public type of the SDK.
 *
 * Wire names never change. A field that crosses the wire keeps its exact name from
 * `decide.schema.ts`, `snake_case` included. Only SDK-invented names are camelCase.
 */

// ---- client -------------------------------------------------------------

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
  /** For tests, proxies, or a Workers service binding. Default globalThis.fetch. */
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

// ---- decision, usage and rate limits ------------------------------------

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

/**
 * The numbers come from the previous request at that Cloudflare colo. The middleware
 * accounts after the response. Read them as a trailing gauge, never as admission control.
 */
export interface RateLimit {
  limitRequests: number
  remainingRequests: number
  /** OpenAI style, for example '5m0s'. */
  resetRequests: string
  limitTokens: number
  remainingTokens: number
  resetTokens: string
}

// ---- errors -------------------------------------------------------------

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_schema' // 400
  | 'missing_api_key'
  | 'invalid_api_key' // 401
  | 'rate_limit_exceeded'
  | 'insufficient_quota' // 429
  | 'runner_error' // 502
  | 'overloaded' // 529
  | 'http_error'
  | 'internal_error' // 4xx / 500
  | 'connection_error'
  | 'timeout' // no response
  | 'client_error' // raised before any HTTP call
  | (string & {}) // a code shipped after this release

// ---- inference helpers ---------------------------------------------------

export type Input = string | readonly string[]

/** One text gives one result. A tuple of texts gives a tuple of results, same length. */
export type Fan<T extends Input, R> = T extends readonly string[]
  ? { -readonly [K in keyof T]: R }
  : R

/** Label names, or name -> description. */
export type Labels = readonly string[] | Readonly<Record<string, string>>
export type LabelOf<L extends Labels> = L extends readonly (infer S extends string)[]
  ? S
  : Extract<keyof L, string>

/** 0 | 1 | ... | n-1 for a tuple. `number` for a plain array. */
export type IndexOf<S extends readonly unknown[]> = number extends S['length']
  ? number
  : Exclude<keyof S, keyof unknown[]> extends infer K
    ? K extends `${infer N extends number}`
      ? N
      : never
    : never

export interface TreeNode {
  readonly description?: string
  readonly labels?: Tree
}
export type Tree = { readonly [label: string]: string | TreeNode }

/** Every label at every level. What `path` can hold. */
export type TreeLabels<T> =
  | Extract<keyof T, string>
  | {
      [K in keyof T]: T[K] extends { labels: infer C extends object } ? TreeLabels<C> : never
    }[keyof T]

/**
 * Only the labels a walk can stop on. What `label` is.
 *
 * An empty `labels` object is a leaf: `decide.service.ts` stops the walk when the child
 * level holds no key, and `decide.schema.ts` recurses into a non-empty child only.
 */
export type LeafLabels<T> = Extract<
  {
    [K in keyof T]: T[K] extends { labels: infer C extends object }
      ? [keyof C] extends [never]
        ? K
        : LeafLabels<C>
      : K
  }[keyof T],
  string
>

// ---- results -------------------------------------------------------------

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

// ---- extraction ----------------------------------------------------------

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

export type ExtractSchema = JsonSchema | StandardSchemaV1 | Typed<unknown>

export type SchemaOutput<S> =
  S extends StandardSchemaV1<infer O>
    ? O
    : S extends { '~milliseconds.output'?: infer T }
      ? [unknown] extends [T]
        ? FromJsonSchema<S>
        : T
      : FromJsonSchema<S>

/** Reads a JSON Schema object literal at the type level, exactly as `kindOf` reads it. */
export type FromJsonSchema<S> = S extends { enum: readonly (infer E)[] }
  ? E extends string
    ? E
    : string
  : // `kindOf` drops 'null' out of a tuple `type` and reads the rest, so `{type:['number','null']}`
    // is a number. Strip 'null' here too, then read the single remaining type.
    S extends { type: readonly (infer T extends string)[] }
    ? FromJsonSchema<Omit<S, 'type'> & { type: Exclude<T, 'null'> }>
    : S extends { type: 'object' }
      ? S extends { properties: infer P }
        ? { -readonly [K in keyof P]: FromJsonSchema<P[K]> }
        : Record<string, never>
      : S extends { type: 'array' }
        ? S extends { items: infer I }
          ? I extends { type: 'object' }
            ? object[]
            : string[]
          : string[]
        : S extends { type: 'string' }
          ? string
          : S extends { type: 'number' | 'integer' }
            ? number
            : S extends { type: 'boolean' }
              ? boolean
              : S extends { type: string }
                ? undefined // unsupported: the key never appears in `data`
                : string // no `type`: the runner treats it as a string

/**
 * What the runner really sends. A missing value is null. An array of objects is always [].
 * An array of scalars arrives as strings. An enum is not checked server side. A nested
 * object is not nullable, because `setPath` materialises it.
 */
export type Extracted<T> = [T] extends [undefined]
  ? undefined
  : [T] extends [readonly unknown[]]
    ? T extends readonly (infer E)[]
      ? [E] extends [object]
        ? never[]
        : string[] | null
      : never
    : [T] extends [object]
      ? // `Exclude`, not `NonNullable`: the hover then prints 'AB' | 'CD', not NonNullable<...>.
        { -readonly [K in keyof T]-?: Extracted<Exclude<T[K], null | undefined>> }
      : [T] extends [string]
        ? // A plain string field needs no autocomplete brand; an enum does.
          string extends T
          ? string | null
          : T | (string & {}) | null
        : T | null
