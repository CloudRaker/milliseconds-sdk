import { describe, expect, test } from 'vitest'

import { DecisionMachine } from '../src/decision-machine'

/**
 * One call per capability against the live API. It asserts the shape, never the values:
 * the model may move, the contract may not.
 *
 * The org rate limit is shared, so the calls run one after another.
 */
const KEY = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  ?.MS_API_KEY

const TICKET =
  'I was charged twice for my subscription on 12 March and support has not answered. Fix this today.'

describe.skipIf(!KEY)('the live API', () => {
  // describe.skipIf still runs this body, so the key has a placeholder when it is unset.
  const dm = new DecisionMachine({ apiKey: KEY ?? 'sk-ms-unset', maxRetries: 3 })

  test('classify', async () => {
    const { result, usage } = await dm
      .classify(TICKET, {
        billing: 'payments, invoices, charges and refunds',
        shipping: 'delivery, tracking and packages',
        account: 'login, passwords and profile settings',
      })
      .withUsage()
    expect(['billing', 'shipping', 'account']).toContain(result.label)
    expect(result.probability).toBeGreaterThanOrEqual(0)
    expect(result.probability).toBeLessThanOrEqual(1)
    expect(result.confidence).toBeTypeOf('number')
    expect(new Set(Object.keys(result.scores))).toEqual(new Set(['billing', 'shipping', 'account']))
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.inputChars).toBeGreaterThan(0)
    expect(usage.inferenceMs).toBeGreaterThanOrEqual(0)
  })

  test('classify over a batch', async () => {
    const out = await dm.classify([TICKET, 'Where is my parcel?'], ['billing', 'shipping'])
    expect(out).toHaveLength(2)
    for (const r of out) expect(['billing', 'shipping']).toContain(r.label)
  })

  test('yes-no', async () => {
    const out = await dm.yesNo(
      TICKET,
      ['The customer expresses urgency.', 'The customer is asking about shipping.'],
      { when_true: 'Time pressure, ASAP, losing money' },
    )
    expect(out).toHaveLength(2)
    expect(out[0].statement).toBe('The customer expresses urgency.')
    expect(out[0].answer).toBeTypeOf('boolean')
    expect(out[0].probability).toBeTypeOf('number')
  })

  test('rate', async () => {
    const SCALE = ['Calm', 'Annoyed', 'Angry', 'Threatening to leave'] as const
    const r = await dm.rate(TICKET, SCALE)
    expect(r.scores).toHaveLength(4)
    expect(r.level).toBeGreaterThanOrEqual(0)
    expect(r.level).toBeLessThanOrEqual(3)
    expect(r.label).toBe(SCALE[r.level])
    expect(r.score).toBeGreaterThanOrEqual(0)
  })

  test('answer', async () => {
    const [who] = await dm.answer(TICKET, ['What was charged twice?'])
    expect(who.question).toBe('What was charged twice?')
    if (who.answer === null) {
      expect(who.start).toBeNull()
      expect(who.end).toBeNull()
    } else {
      // The text path always sets the offsets beside an answer. Only an image nulls them.
      expect(who.start).toBeTypeOf('number')
      expect(TICKET.slice(who.start ?? 0, who.end ?? 0)).toBeTypeOf('string')
    }
  })

  test('extract', async () => {
    const data = await dm.extract(TICKET, {
      type: 'object',
      properties: {
        charge_date: { description: 'the date the charge happened' },
        times_charged: { type: 'number' },
        urgent: { type: 'boolean' },
        products: { type: 'array', items: { type: 'string' } },
      },
    })
    expect(data).toBeTypeOf('object')
    expect(['string', 'object']).toContain(typeof data.charge_date)
    expect(['number', 'object']).toContain(typeof data.times_charged)
    expect(['boolean', 'object']).toContain(typeof data.urgent)
    if (data.products !== null) expect(Array.isArray(data.products)).toBe(true)
  })

  test('entities', async () => {
    const found = await dm.entities(TICKET, {
      date: 'a calendar date',
      product: 'a commercial product or plan',
    })
    expect(Array.isArray(found)).toBe(true)
    for (const e of found) {
      expect(['date', 'product']).toContain(e.type)
      expect(e.text).toBeTypeOf('string')
      expect(e.end).toBeGreaterThanOrEqual(e.start)
    }
  })

  test('verify', async () => {
    const r = await dm.verify(
      TICKET,
      { name: 'charge_date', description: 'the date of the charge' },
      '12 March',
    )
    expect(r.matches).toBeTypeOf('boolean')
    expect(r.probability).toBeTypeOf('number')
    expect(Array.isArray(r.found)).toBe(true)
  })

  test('classify-tree', async () => {
    const r = await dm.classifyTree(TICKET, {
      billing: {
        description: 'payments, invoices, charges, refunds and subscriptions',
        labels: {
          refund_request: 'the customer asks for money back',
          subscription_change: 'the customer wants to upgrade, downgrade or cancel a plan',
        },
      },
      shipping: 'delivery, tracking, lost or damaged parcels',
    })
    expect(r.path.length).toBeGreaterThan(0)
    expect(r.label).toBe(r.path.at(-1))
    expect(r.levels).toHaveLength(r.path.length)
    for (const level of r.levels) {
      expect(level.input_chars).toBeGreaterThan(0)
      expect(level.input_tokens).toBeGreaterThan(0)
      expect(level.inference_ms).toBeGreaterThanOrEqual(0)
    }
  })

  test('rate limits arrive as a trailing gauge', async () => {
    const { usage } = await dm.classify('ping', ['a', 'b']).withUsage()
    if (usage.rateLimit !== null) {
      expect(usage.rateLimit.limitRequests).toBeGreaterThan(0)
      expect(usage.rateLimit.resetRequests).toMatch(/\d+[hms]/)
    }
  })

  test('a bad key is rejected without a retry', async () => {
    const bad = new DecisionMachine({ apiKey: 'sk-ms-nope-nope', maxRetries: 0 })
    await expect(bad.classify('ping', ['a', 'b'])).rejects.toMatchObject({
      code: 'invalid_api_key',
      status: 401,
      attempts: 1,
      retryable: false,
    })
  })
})
