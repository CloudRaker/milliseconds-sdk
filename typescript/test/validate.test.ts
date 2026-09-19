import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { DecisionMachine } from '../src/decision-machine'
import { isMillisecondsError, type MillisecondsError } from '../src/errors'

/** Every check runs before any HTTP call, so this fetch must never be reached. */
const never = vi.fn(() => {
  throw new Error('the SDK sent a request')
}) as unknown as typeof globalThis.fetch

const dm = new DecisionMachine({ apiKey: 'sk-ms-test', fetch: never })

/** The thrown client error. It fails the test when the call did not throw. */
function refusal(run: () => unknown): MillisecondsError {
  try {
    run()
  } catch (e) {
    if (!isMillisecondsError(e)) throw e
    expect(e.status).toBe(0)
    expect(e.code).toBe('client_error')
    return e
  }
  throw new Error('the SDK accepted the call')
}

const message = (run: () => unknown) => refusal(run).message

const long = 'x'.repeat(24_110)

/** A fetch that answers `body` and keeps every request body it saw. */
function recorder(body: string) {
  const sent: Record<string, unknown>[] = []
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(body, { headers: { 'content-type': 'application/json' } })
  })
  return { sent, fetch: fetch as unknown as typeof globalThis.fetch }
}

describe('section 8.1', () => {
  test('no apiKey and no MS_API_KEY', () => {
    expect(message(() => new DecisionMachine({ apiKey: '', fetch: never }))).toBe(
      'No API key. Pass new DecisionMachine({ apiKey }) or set MS_API_KEY. Get a key at https://console.milliseconds.ai.',
    )
  })

  test('an empty text', () => {
    // An empty text is a 400. The SDK answers locally instead of paying for the round trip.
    expect(message(() => dm.yesNo('', 'The text is urgent.'))).toBe(
      'text is empty. Send at least one character.',
    )
    expect(message(() => dm.classify(['ok', ''], ['a', 'b']))).toBe(
      'texts[1] is empty. Send at least one character.',
    )
  })

  test('an empty input array', () => {
    expect(message(() => dm.classify([], ['a', 'b']))).toBe(
      'texts is empty. Send at least one text.',
    )
  })

  test('over 32 texts', () => {
    const batch = Array.from({ length: 41 }, (_, i) => `text ${i}`)
    expect(message(() => dm.classify(batch, ['a', 'b']))).toBe(
      'texts has 41 items. The limit is 32. Split the batch.',
    )
  })

  test('a text over 20,000 characters', () => {
    expect(message(() => dm.classify(['ok', 'ok', 'ok', long], ['a', 'b']))).toBe(
      'texts[3] is 24,110 characters. The limit is 20,000. Split on paragraphs and send the parts as texts.',
    )
    expect(message(() => dm.classify(long, ['a', 'b']))).toBe(
      'text is 24,110 characters. The limit is 20,000. Split on paragraphs and send the parts as texts.',
    )
  })

  test('yes-no with no statement', () => {
    expect(message(() => dm.yesNo('t', ''))).toBe(
      'yes-no needs a statement. The wire message for a body without one names both fields and misleads.',
    )
  })

  test('an empty statements or questions array, or over 32', () => {
    expect(message(() => dm.yesNo('t', []))).toBe('statements has 0 items. Send 1 to 32.')
    expect(message(() => dm.yesNo('t', Array(33).fill('s')))).toBe(
      'statements has 33 items. Send 1 to 32.',
    )
    expect(message(() => dm.answer('t', []))).toBe('questions has 0 items. Send 1 to 32.')
    expect(message(() => dm.answer('t', Array(33).fill('q')))).toBe(
      'questions has 33 items. Send 1 to 32.',
    )
  })

  test('fewer than 2 or more than 64 labels', () => {
    expect(message(() => dm.classify('t', ['billing']))).toBe(
      'labels has 1 entry. classify needs 2 to 64.',
    )
    expect(message(() => dm.classify('t', {}))).toBe('labels is empty. classify needs 2 to 64.')
    const many = Array.from({ length: 65 }, (_, i) => `l${i}`)
    expect(message(() => dm.classify('t', many))).toBe(
      'labels has 65 entries. classify needs 2 to 64.',
    )
  })

  test('a described label set carries no upper bound, because z.record carries none', async () => {
    const r = recorder('{"label":"l0","probability":1,"confidence":1,"scores":{}}')
    const wide = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`l${i}`, 'a topic']))
    await new DecisionMachine({ apiKey: 'sk-ms-x', fetch: r.fetch }).classify('t', wide)
    expect(Object.keys((r.sent[0]?.labels ?? {}) as object)).toHaveLength(70)
    // A tree level keeps 2 to 64: `checkLevel` in decide.schema.ts bounds every level.
    const tree = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`l${i}`, 'a topic']))
    expect(message(() => dm.classifyTree('t', tree))).toBe(
      'labels has 65 entries. classify-tree needs 2 to 64.',
    )
  })

  test('fewer than 1 or more than 64 entity types', () => {
    expect(message(() => dm.entities('t', []))).toBe('types is empty. entities needs 1 to 64.')
    const many = Array.from({ length: 65 }, (_, i) => `t${i}`)
    expect(message(() => dm.entities('t', many))).toBe(
      'types has 65 entries. entities needs 1 to 64.',
    )
  })

  test('fewer than 2 or more than 10 scale levels', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `level ${i}`)
    expect(message(() => dm.rate('t', twelve))).toBe('scale has 12 entries. rate needs 2 to 10.')
    expect(message(() => dm.rate('t', ['Calm']))).toBe('scale has 1 entry. rate needs 2 to 10.')
  })

  test('an extract schema that is not an object with properties', () => {
    expect(message(() => dm.extract('t', { type: 'string' }))).toBe(
      'The schema must be an object with properties.',
    )
    expect(message(() => dm.extract('t', { type: 'object' }))).toBe(
      'The schema must be an object with properties.',
    )
  })

  test('a single entity type is legal, and a two-label classify is legal', async () => {
    // The two minimums differ in decide.schema.ts. One shared rule would reject this.
    const { fetch, sent } = recorder('{"entities":[]}')
    const ok = new DecisionMachine({ apiKey: 'sk-ms-x', fetch })
    await ok.entities('t', ['person'])
    await ok.classify('t', ['a', 'b'])
    expect(sent).toHaveLength(2)
  })
})

describe('the browser guard', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => ({}) })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('a browser without dangerouslyAllowBrowser', () => {
    expect(message(() => new DecisionMachine({ apiKey: 'sk-ms-x', fetch: never }))).toBe(
      'The API key is a secret. Call the API from your server, or pass dangerouslyAllowBrowser: true when the bundle never reaches a user.',
    )
  })

  test('dangerouslyAllowBrowser opens it', () => {
    expect(
      new DecisionMachine({ apiKey: 'sk-ms-x', fetch: never, dangerouslyAllowBrowser: true })
        .baseUrl,
    ).toBe('https://api.milliseconds.ai')
  })
})

describe('a schema the SDK cannot convert', () => {
  test('a Standard Schema with no converter names the one line that converts it', () => {
    const zodLike = { '~standard': { version: 1, vendor: 'zod' } } as const
    const error = refusalOrSchemaError(() => dm.extract('t', zodLike))
    expect(error.code).toBe('invalid_schema')
    expect(error.message).toContain('typed<z.infer<typeof S>>(z.toJSONSchema(S))')
  })

  test('a converter method is called (arktype)', async () => {
    const arkLike = {
      '~standard': { version: 1 as const, vendor: 'arktype' },
      toJsonSchema: () => ({ type: 'object', properties: { a: { type: 'string' } } }),
    }
    const { fetch, sent } = recorder('{"data":{"a":null}}')
    const ok = new DecisionMachine({ apiKey: 'sk-ms-x', fetch })
    expect(await ok.extract('t', arkLike)).toEqual({ a: null })
    expect(sent[0]?.schema).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })
})

function refusalOrSchemaError(run: () => unknown): MillisecondsError {
  try {
    run()
  } catch (e) {
    if (!isMillisecondsError(e)) throw e
    return e
  }
  throw new Error('the SDK accepted the call')
}

test('no check ever reached the network', () => {
  expect(never).not.toHaveBeenCalled()
})
