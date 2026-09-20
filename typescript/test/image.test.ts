import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import { DecisionMachine } from '../src/decision-machine'
import { imageFile } from '../src/node'

import type { MillisecondsError } from '../src/errors'

/** A 1x1 PNG. Small enough to inline, and it starts with the PNG magic bytes. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0))
const DATA_URL = `data:image/png;base64,${PNG_BASE64}`

const RESULT = { label: 'receipt', probability: 0.9, confidence: 0.8, scores: { receipt: 0.9 } }

function stub(body: unknown = RESULT) {
  const calls: Record<string, unknown>[] = []
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { calls, dm: new DecisionMachine({ apiKey: 'sk-ms-test-key', fetch: fetch as never }) }
}

/** A client-side check throws where it is called, so the refusal is caught, not awaited. */
async function refused(call: () => Promise<unknown>): Promise<MillisecondsError> {
  try {
    await call()
  } catch (e) {
    return e as MillisecondsError
  }
  throw new Error('the call succeeded')
}

describe('the image field', () => {
  test('a data URL crosses the wire unchanged, with the detail tier', async () => {
    const { calls, dm } = stub()
    await dm.classify('', ['receipt', 'invoice'], { image: DATA_URL, detail: 'low' })
    expect(calls[0]).toEqual({ labels: ['receipt', 'invoice'], detail: 'low', image: DATA_URL })
  })

  test('an image call with text sends both', async () => {
    const { calls, dm } = stub()
    await dm.classify('the scan of a till receipt', ['receipt', 'invoice'], { image: PNG_BASE64 })
    expect(calls[0]).toEqual({
      text: 'the scan of a till receipt',
      labels: ['receipt', 'invoice'],
      image: PNG_BASE64,
    })
  })

  test('bytes, an ArrayBuffer and a Blob all become the same base64', async () => {
    const { calls, dm } = stub()
    await dm.classify('', ['receipt', 'invoice'], { image: PNG_BYTES })
    await dm.classify('', ['receipt', 'invoice'], { image: PNG_BYTES.buffer as ArrayBuffer })
    await dm.classify('', ['receipt', 'invoice'], { image: new Blob([PNG_BYTES]) })
    for (const call of calls) expect(call.image).toBe(PNG_BASE64)
  })

  test('an empty text without an image is still refused', async () => {
    const { dm } = stub()
    const error = await refused(() => dm.classify('', ['receipt', 'invoice']))
    expect(error.code).toBe('client_error')
  })

  test('a URL is refused before the call', async () => {
    const { calls, dm } = stub()
    const error = await refused(() =>
      dm.classify('', ['receipt', 'invoice'], { image: 'https://example.com/receipt.jpg' }),
    )
    expect(error.code).toBe('client_error')
    expect(error.message).toContain('never fetches a URL')
    expect(calls).toHaveLength(0)
  })

  test('over 5 MB is refused from the base64 length, with no decode', async () => {
    const { calls, dm } = stub()
    const huge = `/9j/${'A'.repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3))}`
    const error = await refused(() => dm.classify('', ['receipt', 'invoice'], { image: huge }))
    expect(error.message).toContain('5 MB')
    expect(calls).toHaveLength(0)
  })

  test('a string that is not a JPEG, PNG or WebP is refused', async () => {
    const { dm } = stub()
    const text = await refused(() => dm.classify('', ['a', 'b'], { image: 'not an image at all' }))
    expect(text.message).toContain('data:image/')
    const gif = await refused(() =>
      dm.classify('', ['a', 'b'], { image: 'data:image/gif;base64,R0lGODlh' }),
    )
    expect(gif.message).toContain('data:image/')
  })

  test('every capability carries the image', async () => {
    const { calls, dm } = stub({ data: {}, boxes: {} })
    await dm.yesNo('', 'The document is a receipt.', { image: PNG_BASE64 })
    await dm.rate('', ['low', 'high'], { image: PNG_BASE64 })
    await dm.answer('', 'What is the total?', { image: PNG_BASE64 })
    await dm.entities('', ['person'], { image: PNG_BASE64 })
    await dm.verify('', 'total', '9.99', { image: PNG_BASE64 })
    await dm.classifyTree('', { billing: 'money', shipping: 'parcels' }, { image: PNG_BASE64 })
    await dm.extract(
      '',
      { type: 'object', properties: { total: { type: 'string' } } },
      {
        image: PNG_BASE64,
        detail: 'high',
      },
    )
    expect(calls).toHaveLength(7)
    for (const call of calls) expect(call.image).toBe(PNG_BASE64)
    expect(calls[6]?.detail).toBe('high')
  })
})

describe('the boxes of an image result', () => {
  test('extract joins boxes to the data', async () => {
    const boxes = { total: [10, 20, 30, 40] }
    const { dm } = stub({ data: { total: '9.99' }, boxes })
    const data = await dm.extract(
      '',
      { type: 'object', properties: { total: { type: 'string' } } },
      {
        image: PNG_BASE64,
      },
    )
    expect(data).toEqual({ total: '9.99', boxes })
  })

  test('a text extract carries no boxes key', async () => {
    const { dm } = stub({ data: { total: '9.99' } })
    const data = await dm.extract('a receipt', {
      type: 'object',
      properties: { total: { type: 'string' } },
    })
    expect(data).toEqual({ total: '9.99' })
  })

  test('the bbox of an entity and of an answer reaches the caller', async () => {
    const entities = stub({ entities: [{ type: 'person', text: 'Ada', bbox: [1, 2, 3, 4] }] })
    const [first] = await entities.dm.entities('', ['person'], { image: PNG_BASE64 })
    expect(first?.bbox).toEqual([1, 2, 3, 4])

    const answer = stub({ answer: '9.99', probability: 0.9, start: null, end: null, bbox: null })
    const one = await answer.dm.answer('', 'What is the total?', { image: PNG_BASE64 })
    expect(one.bbox).toBeNull()
  })
})

test('imageFile reads a file as base64', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dm1-')), 'pixel.png')
  writeFileSync(path, PNG_BYTES)
  expect(imageFile(path)).toBe(PNG_BASE64)
})
