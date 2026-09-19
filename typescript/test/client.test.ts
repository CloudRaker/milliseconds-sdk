import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'

import { DecisionMachine } from '../src/decision-machine'
import { isMillisecondsError, MillisecondsError } from '../src/errors'

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/** Header names are case insensitive, so the stub reads them the way the API does. */
function flat(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init).forEach((value, name) => {
    out[name] = value
  })
  return out
}

/** A fetch that answers the given replies in order, repeating the last one. */
function stub(...replies: Reply[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] =
    []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)] ?? {}
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: flat(init?.headers),
    })
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    })
  })
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

const client = (fetch: typeof globalThis.fetch, maxRetries = 2) =>
  new DecisionMachine({ apiKey: 'sk-ms-test-key', fetch, maxRetries })

/** The MillisecondsError a call threw. It fails the test when the call succeeded. */
const refused = (call: Promise<unknown>): Promise<MillisecondsError> =>
  call.then(
    () => {
      throw new Error('the call succeeded')
    },
    (e: unknown) => e as MillisecondsError,
  )

/** A file of this package, by a path relative to this test. */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const RESULT = { label: 'billing', probability: 0.9, confidence: 0.8, scores: { billing: 0.9 } }

describe('the request body', () => {
  test('one text sends `text`, a batch sends `texts`', async () => {
    const one = stub({ body: RESULT })
    await client(one.fetch).classify('a ticket', ['billing', 'shipping'])
    expect(one.calls[0]?.body).toEqual({ text: 'a ticket', labels: ['billing', 'shipping'] })
    expect(one.calls[0]?.url).toBe('https://api.milliseconds.ai/v1/decision-machine-1/classify')

    const many = stub({ body: { results: [RESULT, RESULT] } })
    await client(many.fetch).classify(['one', 'two'], ['billing', 'shipping'])
    expect(many.calls[0]?.body).toEqual({
      texts: ['one', 'two'],
      labels: ['billing', 'shipping'],
    })
  })

  test('one statement sends `statement`, a list sends `statements`', async () => {
    const one = stub({ body: { statement: 's', answer: true, probability: 0.9 } })
    await client(one.fetch).yesNo('t', 'It is urgent.', { when_true: 'ASAP' })
    expect(one.calls[0]?.body).toEqual({ text: 't', statement: 'It is urgent.', when_true: 'ASAP' })

    const many = stub({ body: { results: [{ statement: 's', answer: true, probability: 0.9 }] } })
    await client(many.fetch).yesNo('t', ['It is urgent.'])
    expect(many.calls[0]?.body).toEqual({ text: 't', statements: ['It is urgent.'] })
  })

  test('a bare field name is sent as { name }', async () => {
    const s = stub({ body: { matches: true, probability: 0.9, found: ['4471'] } })
    await client(s.fetch).verify('t', 'invoice_number', 4471)
    expect(s.calls[0]?.body).toEqual({
      text: 't',
      field: { name: 'invoice_number' },
      value: 4471,
    })
  })

  test('the key and the user agent ride on every request', async () => {
    const s = stub({ body: RESULT })
    await client(s.fetch).classify('t', ['a', 'b'])
    expect(s.calls[0]?.headers.authorization).toBe('Bearer sk-ms-test-key')
    expect(s.calls[0]?.headers['user-agent']).toMatch(/^cloudraker-milliseconds-js\//)
  })

  test('caller headers cannot override authorization, in either case', async () => {
    const s = stub({ body: RESULT })
    const dm = new DecisionMachine({
      apiKey: 'sk-ms-real',
      fetch: s.fetch,
      headers: { Authorization: 'Bearer sk-ms-fake', 'x-trace': '1' },
    })
    await dm.classify('t', ['a', 'b'], { headers: { AUTHORIZATION: 'Bearer sk-ms-other' } })
    expect(s.calls[0]?.headers.authorization).toBe('Bearer sk-ms-real')
    expect(s.calls[0]?.headers['x-trace']).toBe('1')
  })
})

describe('the three envelope unwraps', () => {
  test('{ results } becomes an array', async () => {
    const s = stub({ body: { results: [RESULT, RESULT] } })
    const out = await client(s.fetch).classify(['a', 'b'], ['billing', 'shipping'])
    expect(out).toEqual([RESULT, RESULT])
  })

  test('{ entities } becomes an array, per text', async () => {
    const entity = { type: 'person', text: 'Ada', probability: 0.9, start: 0, end: 3 }
    const one = stub({ body: { entities: [entity] } })
    expect(await client(one.fetch).entities('Ada', ['person'])).toEqual([entity])

    const many = stub({ body: { results: [{ entities: [entity] }, { entities: [] }] } })
    expect(await client(many.fetch).entities(['Ada', 'nobody'], ['person'])).toEqual([[entity], []])
  })

  test('{ data } becomes the object', async () => {
    const schema = { type: 'object', properties: { total: { type: 'number' } } } as const
    const one = stub({ body: { data: { total: 12 } } })
    expect(await client(one.fetch).extract('t', schema)).toEqual({ total: 12 })

    const many = stub({ body: { results: [{ data: { total: 12 } }, { data: { total: null } }] } })
    expect(await client(many.fetch).extract(['a', 'b'], schema)).toEqual([
      { total: 12 },
      { total: null },
    ])
  })

  test('texts times statements unwraps both levels', async () => {
    const r = { statement: 's', answer: true, probability: 0.9 }
    const s = stub({ body: { results: [{ results: [r] }, { results: [r] }] } })
    expect(await client(s.fetch).yesNo(['a', 'b'], ['s'])).toEqual([[r], [r]])
  })

  test('an unknown response field survives', async () => {
    const s = stub({ body: { ...RESULT, reasoning: 'new in v2' } })
    const out = await client(s.fetch).classify('t', ['a', 'b'])
    expect(out).toMatchObject({ reasoning: 'new in v2' })
  })
})

describe('usage', () => {
  const HEADERS = {
    'x-input-chars': '412',
    'x-input-tokens': '101',
    'x-inference-ms': '381',
    'x-ratelimit-limit-requests': '200',
    'x-ratelimit-remaining-requests': '199',
    'x-ratelimit-reset-requests': '5m0s',
    'x-ratelimit-limit-tokens': '1000000',
    'x-ratelimit-remaining-tokens': '999980',
    'x-ratelimit-reset-tokens': '12s',
  }

  test('withUsage() parses all nine headers', async () => {
    const s = stub({ body: RESULT, headers: HEADERS })
    const { result, usage, response } = await client(s.fetch).classify('t', ['a', 'b']).withUsage()
    expect(result).toEqual(RESULT)
    expect(response.status).toBe(200)
    expect(usage.inputChars).toBe(412)
    expect(usage.inputTokens).toBe(101)
    expect(usage.inferenceMs).toBe(381)
    expect(usage.rateLimit).toEqual({
      limitRequests: 200,
      remainingRequests: 199,
      resetRequests: '5m0s',
      limitTokens: 1_000_000,
      remainingTokens: 999_980,
      resetTokens: '12s',
    })
    expect(usage.headers.get('x-input-chars')).toBe('412')
  })

  test('no x-ratelimit-* headers gives rateLimit: null', async () => {
    const s = stub({ body: RESULT, headers: { 'x-input-chars': '10' } })
    const { usage } = await client(s.fetch).classify('t', ['a', 'b']).withUsage()
    expect(usage.rateLimit).toBeNull()
    expect(usage.inputChars).toBe(10)
    expect(usage.inferenceMs).toBe(0)
  })
})

const fail = (code: string, message: string, status: number, headers?: Record<string, string>) => ({
  status,
  headers,
  body: { error: { code, message } },
})

describe('retries', () => {
  test('one 529, then 200', async () => {
    const s = stub(fail('overloaded', 'Every inference slot stayed busy.', 529), { body: RESULT })
    const out = await client(s.fetch).classify('t', ['a', 'b'])
    expect(out).toEqual(RESULT)
    expect(s.calls).toHaveLength(2)
  })

  test('a 429 sleeps for retry-after', async () => {
    vi.useFakeTimers()
    try {
      const s = stub(fail('rate_limit_exceeded', 'Retry after 2s.', 429, { 'retry-after': '2' }), {
        body: RESULT,
      })
      const pending = client(s.fetch).classify('t', ['a', 'b'])
      await vi.advanceTimersByTimeAsync(1_900)
      expect(s.calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(200)
      expect(await pending).toEqual(RESULT)
      expect(s.calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a 400 is never retried', async () => {
    const s = stub(
      fail('invalid_request', 'labels: Too small: expected array to have >=2 items', 400),
    )
    const error = await refused(client(s.fetch).classify('t', ['a', 'b']))
    expect(s.calls).toHaveLength(1)
    expect(isMillisecondsError(error)).toBe(true)
    expect(error.code).toBe('invalid_request')
    expect(error.status).toBe(400)
    expect(error.attempts).toBe(1)
    expect(error.retryable).toBe(false)
    expect(error.retryAfter).toBeNull()
    expect(error.apiMessage).toBe('labels: Too small: expected array to have >=2 items')
    expect(error.message).toContain('milliseconds rejected the request (400 invalid_request)')
    expect(error.message).toContain('classify needs two or more labels')
  })

  test('insufficient_quota is never retried, and carries no retry-after', async () => {
    const s = stub(fail('insufficient_quota', 'No credits left.', 429))
    const error = await refused(client(s.fetch).classify('t', ['a', 'b']))
    expect(s.calls).toHaveLength(1)
    expect(error.retryAfter).toBeNull()
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('no token credits left (429 insufficient_quota)')
    expect(error.message).toContain('Not retried. A timer retry will not help.')
  })

  test('a spent retry budget throws with the attempt count', async () => {
    const s = stub(fail('overloaded', 'busy', 529, { 'retry-after': '0' }))
    const error = await refused(client(s.fetch, 2).classify('t', ['a', 'b']))
    expect(s.calls).toHaveLength(3)
    expect(error.attempts).toBe(3)
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('after 3 attempts over')
  })

  test('maxRetries: 0 turns retries off, per call', async () => {
    const s = stub(fail('overloaded', 'busy', 529))
    const error = await refused(client(s.fetch).classify('t', ['a', 'b'], { maxRetries: 0 }))
    expect(s.calls).toHaveLength(1)
    expect(error.attempts).toBe(1)
  })

  test('a transport failure retries, then reports connection_error', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const error = await refused(
      client(fetch as unknown as typeof globalThis.fetch, 1).classify('t', ['a', 'b']),
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(error.code).toBe('connection_error')
    expect(error.status).toBe(0)
    expect(error.response).toBeNull()
  })

  test('a 503 with no JSON body retries on the status, a 500 does not', async () => {
    const edge = stub({ status: 503, body: 'an edge error page' }, { body: RESULT })
    expect(await client(edge.fetch).classify('t', ['a', 'b'])).toEqual(RESULT)
    expect(edge.calls).toHaveLength(2)

    const server = stub({ status: 500, body: 'an edge error page' })
    const error = await refused(client(server.fetch).classify('t', ['a', 'b']))
    expect(server.calls).toHaveLength(1)
    expect(error.code).toBe('internal_error')
  })

  test('an abort during the retry backoff lands at once', async () => {
    const s = stub(fail('rate_limit_exceeded', 'slow down', 429, { 'retry-after': '5' }))
    const stop = new AbortController()
    const started = Date.now()
    const pending = client(s.fetch).classify('t', ['a', 'b'], { signal: stop.signal })
    setTimeout(() => stop.abort(new Error('user cancelled')), 20)
    await expect(pending).rejects.toThrow('user cancelled')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(s.calls).toHaveLength(1)
  })

  test('the API key error names the console', async () => {
    const s = stub(fail('invalid_api_key', 'Incorrect API key provided.', 401))
    const error = await refused(client(s.fetch).classify('t', ['a', 'b']))
    expect(s.calls).toHaveLength(1)
    expect(error.message).toContain('milliseconds rejected the API key (401 invalid_api_key)')
    expect(error.message).toContain('https://console.milliseconds.ai')
  })
})

describe('the error object', () => {
  test('withUsage() on a failing call leaves no unhandled rejection', async () => {
    const s = stub(fail('invalid_request', 'bad labels', 400))
    const loose: unknown[] = []
    const watch = (reason: unknown) => loose.push(reason)
    process.on('unhandledRejection', watch)
    try {
      const error = await refused(client(s.fetch).classify('t', ['a', 'b']).withUsage())
      expect(error.code).toBe('invalid_request')
      // Node reports an unhandled rejection one macrotask after the microtasks drain.
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', watch)
    }
    expect(loose).toEqual([])
  })

  test('response still holds an unread body', async () => {
    const s = stub(fail('invalid_request', 'bad labels', 400))
    const error = await refused(client(s.fetch).classify('t', ['a', 'b']))
    expect(error.response?.status).toBe(400)
    expect(error.response?.bodyUsed).toBe(false)
    expect(await error.response?.json()).toEqual({
      error: { code: 'invalid_request', message: 'bad labels' },
    })
  })
})

describe('the client itself', () => {
  test('one version, in package.json, the user agent and dm1', async () => {
    const { version } = JSON.parse(read('../package.json')) as { version: string }
    const s = stub({ body: RESULT })
    await client(s.fetch).classify('t', ['a', 'b'])
    expect(s.calls[0]?.headers['user-agent']).toBe(`cloudraker-milliseconds-js/${version}`)
    expect(read('../src/cli/run.ts')).toContain(`const VERSION = '${version}'`)
  })

  test('a trailing slash on baseUrl is trimmed', async () => {
    const s = stub({ body: RESULT })
    const dm = new DecisionMachine({
      apiKey: 'sk-ms-x',
      fetch: s.fetch,
      baseUrl: 'http://localhost:8787/',
    })
    expect(dm.baseUrl).toBe('http://localhost:8787')
    await dm.classify('t', ['a', 'b'])
    expect(s.calls[0]?.url).toBe('http://localhost:8787/v1/decision-machine-1/classify')
  })

  test('post() reaches any path with the raw body', async () => {
    const s = stub({ body: { results: [RESULT] } })
    const raw = await client(s.fetch).post<{ results: unknown[] }>('/v1/anything', { text: 't' })
    expect(raw.results).toHaveLength(1)
    expect(s.calls[0]?.url).toBe('https://api.milliseconds.ai/v1/anything')
  })

  test('the model is fixed', () => {
    expect(DecisionMachine.model).toBe('decision-machine-1')
  })
})
