import { MillisecondsError } from './errors'
import { checkRuntime } from './validate'

import type { CallOptions, ClientOptions, Decision, ErrorCode, RateLimit, Usage } from './types'

// ponytail: bumped by hand beside package.json. A build-time define would be config for a
// value that changes once per release.
const VERSION = '0.2.0'
const USER_AGENT = `cloudraker-milliseconds-js/${VERSION}`

const DEFAULT_BASE_URL = 'https://api.milliseconds.ai'
const RETRY = new Set([
  'rate_limit_exceeded',
  'runner_error',
  'overloaded',
  'connection_error',
  'timeout',
])
/** Full jitter, capped at 8 s. */
const backoff = (n: number) => Math.random() * Math.min(500 * 2 ** n, 8_000)
/** Resolves early when the caller aborts. The loop then throws the caller's reason. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

/** Reads an environment variable without assuming `process` exists. */
function env(name: string): string | undefined {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.[name]
  } catch {
    return undefined
  }
}

/** A Promise of the result, with the headers one call away. No Promise subclass. */
const decision = <T>(p: Promise<{ result: T; usage: Usage; response: Response }>): Decision<T> => {
  const result = p.then((r) => r.result)
  return Object.assign(result, {
    withUsage: () => {
      // The caller awaits `p` alone, so `result` rejects with nobody watching. Node kills
      // the process for that. One no-op handler answers it, and `await d` still rejects.
      result.catch(() => {})
      return p
    },
  })
}

function rateLimitOf(h: Headers): RateLimit | null {
  const limitRequests = h.get('x-ratelimit-limit-requests')
  // The middleware writes all six values together, or none.
  if (limitRequests === null) return null
  const num = (k: string) => Number(h.get(k)) || 0
  return {
    limitRequests: Number(limitRequests) || 0,
    remainingRequests: num('x-ratelimit-remaining-requests'),
    resetRequests: h.get('x-ratelimit-reset-requests') ?? '',
    limitTokens: num('x-ratelimit-limit-tokens'),
    remainingTokens: num('x-ratelimit-remaining-tokens'),
    resetTokens: h.get('x-ratelimit-reset-tokens') ?? '',
  }
}

function usageOf(response: Response): Usage {
  const h = response.headers
  const num = (k: string) => Number(h.get(k)) || 0
  return {
    inputChars: num('x-input-chars'),
    inputTokens: num('x-input-tokens'),
    inferenceMs: num('x-inference-ms'),
    rateLimit: rateLimitOf(h),
    headers: h,
  }
}

/** The hint line under the API message. Section 8.2 of DESIGN.md holds the copy. */
function describe(
  code: string,
  status: number,
  apiMessage: string,
  attempts: number,
  ms: number,
): string {
  const over = attempts > 1 ? ` after ${attempts} attempts over ${(ms / 1000).toFixed(1)}s` : ''
  const tail = apiMessage ? `:\n${apiMessage}` : '.'
  switch (code) {
    case 'missing_api_key':
    case 'invalid_api_key':
      return `milliseconds rejected the API key (${status} ${code}).\nKeys start with "sk-ms-". Check MS_API_KEY, or create a key at\nhttps://console.milliseconds.ai.`
    case 'rate_limit_exceeded':
      return `rate limited (${status} ${code})${over}${tail}\n  Lower your concurrency, or raise maxRetries. Limits are per organization and\n  shared by every key.`
    case 'insufficient_quota':
      return `no token credits left (${status} ${code})${tail}\n  Not retried. A timer retry will not help.`
    case 'overloaded':
      return `every inference slot stayed busy (${status} ${code})${over}${tail}\n  This is backpressure, not a fault. Send fewer texts per call, or back off further.\n  A texts batch of 32 asks for 32 slots at once.`
    case 'runner_error':
      return `inference failed twice (${status} ${code})${over}${tail}\n  The model, not your request. Retry later, or raise maxRetries.`
    case 'timeout':
      return `the request timed out${over}${tail}\n  Raise timeout, or send fewer texts per call.`
    case 'connection_error':
      return `could not reach the API${over}${tail}\n  Check baseUrl and the network. maxRetries: 0 fails fast.`
    default: {
      const hint = apiMessage.startsWith('labels:')
        ? '\n  classify needs two or more labels. Describe each one. Described labels score\n  measurably better than bare names.'
        : ''
      return `milliseconds rejected the request (${status} ${code})${tail}${hint}`
    }
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string }
}

/** One AbortSignal for the attempt: the per-attempt timeout, plus the caller's signal. */
function attemptSignal(
  timeout: number,
  signal?: AbortSignal,
): { signal: AbortSignal; done: () => void } {
  const hasAny = typeof AbortSignal.any === 'function'
  if (typeof AbortSignal.timeout === 'function' && (!signal || hasAny)) {
    const t = AbortSignal.timeout(timeout)
    return { signal: signal ? AbortSignal.any([signal, t]) : t, done: () => {} }
  }
  const controller = new AbortController()
  // `transportError` reads `.name`, and the name of `new Error('TimeoutError')` is 'Error'.
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    timeout,
  )
  signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

/** Transport: fetch, retries, errors and usage. Every capability is two lines on top. */
export class Client {
  readonly baseUrl: string
  readonly #apiKey: string
  readonly #timeout: number
  readonly #maxRetries: number
  readonly #headers: Record<string, string>
  readonly #fetch: typeof globalThis.fetch

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env('MS_API_KEY')
    checkRuntime(apiKey, options.dangerouslyAllowBrowser)
    this.#apiKey = apiKey
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#timeout = options.timeout ?? 60_000
    this.#maxRetries = options.maxRetries ?? 2
    this.#headers = { ...options.headers }
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** Escape hatch. Your path, your body, your type, the SDK's auth, retries and errors. */
  post<R>(path: string, body: unknown, options?: CallOptions): Decision<R> {
    return this.call<R>(path, body, options, (raw) => raw as R)
  }

  /** `unwrap` maps the parsed body to the result. It follows the request, never the response. */
  protected call<R>(
    path: string,
    // A promise, when the body waits on a Blob's bytes.
    body: unknown | Promise<unknown>,
    options: CallOptions | undefined,
    unwrap: (raw: unknown) => R,
  ): Decision<R> {
    return decision(
      this.send(path, body, options ?? {}).then(({ response, raw }) => ({
        result: unwrap(raw),
        usage: usageOf(response),
        response,
      })),
    )
  }

  private async send(
    path: string,
    body: unknown | Promise<unknown>,
    call: CallOptions,
  ): Promise<{ response: Response; raw: unknown }> {
    const url = `${this.baseUrl}${path}`
    const maxRetries = call.maxRetries ?? this.#maxRetries
    const timeout = call.timeout ?? this.#timeout
    // A Headers object, because `Authorization` and `authorization` are the same header.
    // A plain-object spread keeps both keys, and the two values then join with a comma.
    const headers = new Headers({ 'content-type': 'application/json', 'user-agent': USER_AGENT })
    for (const [k, v] of Object.entries({ ...this.#headers, ...call.headers })) headers.set(k, v)
    headers.set('authorization', `Bearer ${this.#apiKey}`)
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(await body) }
    const started = Date.now()

    for (let attempt = 1; ; attempt++) {
      // The caller can abort while the previous attempt's backoff sleeps.
      if (call.signal?.aborted) throw call.signal.reason
      const outcome = await this.attempt(url, init, timeout, call.signal, attempt, started)
      if (!(outcome instanceof MillisecondsError)) return outcome
      if (!outcome.retryable || attempt > maxRetries) throw outcome
      // Honour retry-after when the API sent one, capped at a minute. Otherwise full jitter.
      const wait =
        outcome.retryAfter === null
          ? backoff(attempt - 1)
          : Math.min(outcome.retryAfter, 60) * 1_000
      await sleep(wait, call.signal)
    }
  }

  private async attempt(
    url: string,
    init: RequestInit,
    timeout: number,
    signal: AbortSignal | undefined,
    attempt: number,
    started: number,
  ): Promise<{ response: Response; raw: unknown } | MillisecondsError> {
    const guard = attemptSignal(timeout, signal)
    try {
      const response = await this.#fetch(url, { ...init, signal: guard.signal })
      if (response.ok) return { response, raw: await response.json() }
      return await httpError(response, attempt, Date.now() - started)
    } catch (cause) {
      // The caller aborted: their reason, not ours.
      if (signal?.aborted) throw cause
      return transportError(cause, attempt, Date.now() - started)
    } finally {
      guard.done()
    }
  }
}

function transportError(cause: unknown, attempts: number, ms: number): MillisecondsError {
  const name = (cause as Error | undefined)?.name ?? ''
  const timedOut = name === 'TimeoutError' || name === 'AbortError'
  const code: ErrorCode = timedOut ? 'timeout' : 'connection_error'
  const apiMessage = (cause as Error | undefined)?.message ?? String(cause)
  return new MillisecondsError({
    code,
    status: 0,
    apiMessage,
    message: describe(code, 0, apiMessage, attempts, ms),
    attempts,
    retryable: true,
    cause,
  })
}

async function httpError(
  response: Response,
  attempts: number,
  ms: number,
): Promise<MillisecondsError> {
  // A clone, so `error.response` still holds an unread body.
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as ErrorBody | null
  const code: ErrorCode =
    body?.error?.code ?? (response.status >= 500 ? 'internal_error' : 'http_error')
  const apiMessage = body?.error?.message ?? response.statusText
  const retryAfter = response.headers.get('retry-after')
  return new MillisecondsError({
    code,
    status: response.status,
    apiMessage,
    message: describe(code, response.status, apiMessage, attempts, ms),
    retryAfter: retryAfter === null ? null : Number(retryAfter) || 0,
    rateLimit: rateLimitOf(response.headers),
    response,
    attempts,
    // A Cloudflare 502/503/504 error page never reaches the worker, so it carries no code.
    retryable: RETRY.has(code) || (response.status >= 502 && response.status <= 504),
  })
}
