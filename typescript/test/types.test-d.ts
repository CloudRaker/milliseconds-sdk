import { expectTypeOf, test } from 'vitest'

import { DecisionMachine, isMillisecondsError, typed } from '../src/index'

import type { MillisecondsError } from '../src/errors'
import type {
  AnswerResult,
  BBox,
  Boxes,
  ClassifyResult,
  ClassifyTreeResult,
  Entity,
  Extracted,
  Fan,
  IndexOf,
  LeafLabels,
  RateLimit,
  RateResult,
  TreeLabels,
  VerifyResult,
  YesNoResult,
} from '../src/types'

/** A compile error unless `A extends B`. */
type Assignable<A, B> = [A] extends [B] ? true : false
// oxlint-disable-next-line no-unused-vars -- the type parameter is the assertion
const yes = <_T extends true>(): void => {}

declare const failure: MillisecondsError

declare const dm: DecisionMachine
declare const ticket: string
declare const article: string
declare const message: string
declare const letter: string
declare const pdfText: string
declare const t1: string
declare const t2: string
declare const t3: string
declare const tickets: string[]
declare const passages: string[]

const LABELS = {
  billing: 'payments, invoices, charges and refunds',
  shipping: 'delivery, tracking and packages',
  account: 'login, passwords and profile settings',
}
type Intent = 'billing' | 'shipping' | 'account'

// ---- 7.1 classify: your label union --------------------------------------

test('7.1 classify infers the label union', async () => {
  const r = await dm.classify(ticket, {
    billing: 'payments, invoices, charges and refunds',
    shipping: 'delivery, tracking and packages',
    account: 'login, passwords and profile settings',
  })
  expectTypeOf(r).toEqualTypeOf<ClassifyResult<Intent>>()
  expectTypeOf(r.label).toEqualTypeOf<Intent>()
  expectTypeOf(r.scores).toEqualTypeOf<Record<Intent, number>>()
  expectTypeOf(r.probability).toEqualTypeOf<number>()
  expectTypeOf(r.confidence).toEqualTypeOf<number>()
  // @ts-expect-error this comparison has no overlap
  void (r.label === 'refunds')
})

test('an array of labels needs no `as const`', async () => {
  const r = await dm.classify(ticket, ['a', 'b'])
  expectTypeOf(r.label).toEqualTypeOf<'a' | 'b'>()
  expectTypeOf(r.scores).toEqualTypeOf<Record<'a' | 'b', number>>()
  // @ts-expect-error 'c' is not one of the labels
  void (r.label === 'c')
})

// ---- 7.2 a tuple of texts gives a tuple of results -----------------------

test('7.2 a tuple of texts gives a tuple of results', async () => {
  const three = await dm.classify([t1, t2, t3], LABELS)
  expectTypeOf(three).toEqualTypeOf<
    [ClassifyResult<Intent>, ClassifyResult<Intent>, ClassifyResult<Intent>]
  >()
  const [a, b, c] = three
  expectTypeOf(a).toEqualTypeOf<ClassifyResult<Intent>>()
  expectTypeOf(b).toEqualTypeOf<ClassifyResult<Intent>>()
  expectTypeOf(c).toEqualTypeOf<ClassifyResult<Intent>>()
  // @ts-expect-error there is no fourth result
  const [, , , fourth] = three
  void fourth

  const many = await dm.classify(tickets, LABELS)
  expectTypeOf(many).toEqualTypeOf<ClassifyResult<Intent>[]>()
})

// ---- 7.3 yes-no: statements map positionally -----------------------------

test('7.3 yes-no maps statements positionally', async () => {
  const pair = await dm.yesNo(
    ticket,
    ['The customer expresses urgency.', 'The customer is asking about shipping.'],
    { when_true: 'Time pressure, ASAP, losing money' },
  )
  expectTypeOf(pair).toEqualTypeOf<
    [
      YesNoResult<'The customer expresses urgency.'>,
      YesNoResult<'The customer is asking about shipping.'>,
    ]
  >()
  const [urgent] = pair
  expectTypeOf(urgent.statement).toEqualTypeOf<'The customer expresses urgency.'>()
  expectTypeOf(urgent.answer).toEqualTypeOf<boolean>()

  const grid = await dm.yesNo(passages, ['The passage answers the question.'])
  expectTypeOf(grid).toEqualTypeOf<[YesNoResult<'The passage answers the question.'>][]>()

  const one = await dm.yesNo(ticket, 'The customer expresses urgency.')
  expectTypeOf(one).toEqualTypeOf<YesNoResult<'The customer expresses urgency.'>>()
})

// ---- 7.4 rate ------------------------------------------------------------

test('7.4 rate gives level, label and a fixed-length scores tuple', async () => {
  const r = await dm.rate(message, ['Calm', 'Annoyed', 'Angry', 'Threatening to leave'])
  expectTypeOf(r).toEqualTypeOf<
    RateResult<readonly ['Calm', 'Annoyed', 'Angry', 'Threatening to leave']>
  >()
  expectTypeOf(r.label).toEqualTypeOf<'Calm' | 'Annoyed' | 'Angry' | 'Threatening to leave'>()
  expectTypeOf(r.level).toEqualTypeOf<0 | 1 | 2 | 3>()
  expectTypeOf(r.scores).toEqualTypeOf<[number, number, number, number]>()
  expectTypeOf(r.score).toEqualTypeOf<number>()
})

// ---- 7.5 extract from a JSON Schema literal ------------------------------

test('7.5 extract reads a JSON Schema literal', async () => {
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
  expectTypeOf(data.due_date).toEqualTypeOf<string | null>()
  expectTypeOf(data.total).toEqualTypeOf<number | null>()
  expectTypeOf(data.paid).toEqualTypeOf<boolean | null>()
  expectTypeOf(data.reference).toEqualTypeOf<'AB' | 'CD' | (string & {}) | null>()
  expectTypeOf(data.tags).toEqualTypeOf<string[] | null>()
  expectTypeOf(data.amounts).toEqualTypeOf<string[] | null>()
  expectTypeOf(data.line_items).toEqualTypeOf<never[]>()
  expectTypeOf(data.vendor).toEqualTypeOf<{ name: string | null }>()
  expectTypeOf(data.when).toEqualTypeOf<undefined>()
})

test('a nullable union type reads the way kindOf reads it', async () => {
  // lib/json-schema.ts drops 'null' out of a tuple `type` and reads the rest.
  const data = await dm.extract(letter, {
    type: 'object',
    properties: {
      total: { type: ['number', 'null'] },
      count: { type: ['integer', 'null'] },
      paid: { type: ['boolean', 'null'] },
      vendor: { type: ['string', 'null'] },
      lines: { type: ['array', 'null'], items: { type: 'object' } },
    },
  })
  expectTypeOf(data.total).toEqualTypeOf<number | null>()
  expectTypeOf(data.count).toEqualTypeOf<number | null>()
  expectTypeOf(data.paid).toEqualTypeOf<boolean | null>()
  expectTypeOf(data.vendor).toEqualTypeOf<string | null>()
  expectTypeOf(data.lines).toEqualTypeOf<never[]>()
})

// ---- 7.6 extract with a branded schema (zod, valibot) --------------------

interface InvoiceShape {
  invoice_number: string
  total: number
  currency: 'USD' | 'EUR' | 'GBP'
  line_items: { sku: string }[]
}

test('7.6 typed() carries the schema type across the converter', async () => {
  // In a zod 4 project this line is typed<z.infer<typeof Invoice>>(z.toJSONSchema(Invoice)).
  const Invoice = typed<InvoiceShape>({
    type: 'object',
    properties: {
      invoice_number: { type: 'string', description: 'the identifier printed on the invoice' },
      total: { type: 'number', description: 'the amount due including tax' },
      currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'] },
      line_items: { type: 'array', items: { type: 'object' } },
    },
  })
  const data = await dm.extract(pdfText, Invoice)
  expectTypeOf(data.invoice_number).toEqualTypeOf<string | null>()
  expectTypeOf(data.total).toEqualTypeOf<number | null>()
  expectTypeOf(data.currency).toEqualTypeOf<'USD' | 'EUR' | 'GBP' | (string & {}) | null>()
  expectTypeOf(data.line_items).toEqualTypeOf<never[]>()
  if (data.total !== null) expectTypeOf(data.total).toEqualTypeOf<number>()
})

// ---- 7.7 classify-tree: two different unions -----------------------------

const TAXONOMY = {
  billing: {
    description: 'payments, invoices, charges, refunds and subscriptions',
    labels: {
      refund_request: 'the customer asks for money back',
      subscription_change: 'the customer wants to upgrade, downgrade or cancel a plan',
    },
  },
  shipping: 'delivery, tracking, lost or damaged parcels',
} as const

type Every = 'billing' | 'shipping' | 'refund_request' | 'subscription_change'
type Leaf = 'refund_request' | 'subscription_change' | 'shipping'

test('7.7 classify-tree separates every label from the leaves', async () => {
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
  expectTypeOf(r.label).toEqualTypeOf<Leaf>()
  expectTypeOf(r.path).toEqualTypeOf<Every[]>()
  expectTypeOf(r.levels[0]!.input_tokens).toEqualTypeOf<number>()
  expectTypeOf(r.levels[0]!.scores).toEqualTypeOf<Record<string, number>>()
  expectTypeOf(r).toEqualTypeOf<ClassifyTreeResult<Every, Leaf>>()
})

test('an empty labels object is a leaf, the way the service walks it', async () => {
  // decide.service.ts stops when the child level holds no key, so `alpha` is a stop.
  const r = await dm.classifyTree(ticket, {
    alpha: { description: 'the first branch', labels: {} },
    beta: 'the second branch',
  })
  expectTypeOf(r.label).toEqualTypeOf<'alpha' | 'beta'>()
})

test('TreeLabels holds every label, LeafLabels only the stops', () => {
  expectTypeOf<TreeLabels<typeof TAXONOMY>>().toEqualTypeOf<Every>()
  expectTypeOf<LeafLabels<typeof TAXONOMY>>().toEqualTypeOf<Leaf>()
  yes<Assignable<LeafLabels<typeof TAXONOMY>, TreeLabels<typeof TAXONOMY>>>()
})

// ---- 7.8 answer: the null case narrows -----------------------------------

test('7.8 answer narrows the null case', async () => {
  const [who, cost] = await dm.answer(article, [
    'Who announced the product?',
    'How much does it cost?',
  ])
  expectTypeOf(who).toEqualTypeOf<AnswerResult<'Who announced the product?'>>()
  expectTypeOf(cost).toEqualTypeOf<AnswerResult<'How much does it cost?'>>()
  // An answer over an image has no text to index, so the offsets are null beside it.
  if (who.answer !== null) {
    expectTypeOf(who.start).toEqualTypeOf<number | null>()
    expectTypeOf(who.end).toEqualTypeOf<number | null>()
    expectTypeOf(who.bbox).toEqualTypeOf<BBox | null | undefined>()
  }
  if (who.start !== null && who.end !== null) article.slice(who.start, who.end)
  expectTypeOf(cost.start).toEqualTypeOf<number | null>()
  // @ts-expect-error start is number | null before the check
  article.slice(cost.start, cost.end)
})

// ---- the remaining capabilities ------------------------------------------

test('entities and verify', async () => {
  const found = await dm.entities(ticket, ['person', 'place'])
  expectTypeOf(found).toEqualTypeOf<Entity<'person' | 'place'>[]>()
  const batch = await dm.entities([t1, t2], { person: 'a human name' })
  expectTypeOf(batch).toEqualTypeOf<[Entity<'person'>[], Entity<'person'>[]]>()

  const v = await dm.verify(ticket, 'invoice_number', 4471)
  expectTypeOf(v).toEqualTypeOf<VerifyResult>()
  const vs = await dm.verify(tickets, { name: 'total', description: 'the amount due' }, '99.00')
  expectTypeOf(vs).toEqualTypeOf<VerifyResult[]>()
})

test('post is the escape hatch', async () => {
  const raw = await dm.post<{ results: { label: string }[] }>('/v1/decision-machine-1/classify', {})
  expectTypeOf(raw.results).toEqualTypeOf<{ label: string }[]>()
})

// ---- the helper types ----------------------------------------------------

test('Fan over a tuple and over an array', () => {
  expectTypeOf<Fan<readonly [string, string], number>>().toEqualTypeOf<[number, number]>()
  expectTypeOf<Fan<string[], number>>().toEqualTypeOf<number[]>()
  expectTypeOf<Fan<string, number>>().toEqualTypeOf<number>()
})

test('IndexOf over a tuple and over an array', () => {
  expectTypeOf<IndexOf<readonly ['a', 'b', 'c']>>().toEqualTypeOf<0 | 1 | 2>()
  expectTypeOf<IndexOf<string[]>>().toEqualTypeOf<number>()
})

test('Extracted states the four degradations', () => {
  expectTypeOf<Extracted<string>>().toEqualTypeOf<string | null>()
  expectTypeOf<Extracted<number>>().toEqualTypeOf<number | null>()
  expectTypeOf<Extracted<boolean>>().toEqualTypeOf<boolean | null>()
  expectTypeOf<Extracted<'AB' | 'CD'>>().toEqualTypeOf<'AB' | 'CD' | (string & {}) | null>()
  expectTypeOf<Extracted<string[]>>().toEqualTypeOf<string[] | null>()
  expectTypeOf<Extracted<number[]>>().toEqualTypeOf<string[] | null>()
  expectTypeOf<Extracted<{ sku: string }[]>>().toEqualTypeOf<never[]>()
  expectTypeOf<Extracted<{ name: string }>>().toEqualTypeOf<{ name: string | null }>()
  expectTypeOf<Extracted<undefined>>().toEqualTypeOf<undefined>()
})

test('ErrorCode narrows in a switch and never goes stale', () => {
  let handled: string
  switch (failure.code) {
    case 'invalid_request':
    case 'invalid_schema':
      handled = 'bad request'
      break
    case 'rate_limit_exceeded':
      expectTypeOf(failure.retryAfter).toEqualTypeOf<number | null>()
      handled = 'slow down'
      break
    case 'insufficient_quota':
      yes<Assignable<'insufficient_quota', typeof failure.code>>()
      handled = 'buy credits'
      break
    default:
      // A code shipped after this release still type-checks.
      handled = failure.code
  }
  expectTypeOf(handled).toEqualTypeOf<string>()
})

// ---- the README --------------------------------------------------------------
// Every snippet of README.md, so a doc example cannot rot. The zod snippet is the
// `typed()` test above: zod itself is not a dependency of this package.

declare const invoiceText: string
declare const t4: string
declare const wait: (seconds: number | null) => void
declare const topUp: () => void
declare const fix: (apiMessage: string) => void
declare const workerEnv: { MS_API_KEY: string; MILLISECONDS: { fetch: typeof globalThis.fetch } }

test('the README image snippet compiles', async () => {
  const dm = new DecisionMachine({ apiKey: 'sk-ms-x' })
  const DOCUMENT_TYPES = { receipt: 'a till receipt', invoice: 'a supplier invoice' }
  const RECEIPT = { type: 'object', properties: { total: { type: 'string' } } } as const
  // `imageFile` is the Node subpath. Any bytes work the same.
  const receipt = new Uint8Array([0xff, 0xd8, 0xff])

  const kind = await dm.classify('', DOCUMENT_TYPES, { image: receipt })
  expectTypeOf(kind.label).toEqualTypeOf<'receipt' | 'invoice'>()

  const scanned = await dm.extract('the scan of a till receipt', RECEIPT, {
    image: receipt,
    detail: 'high',
  })
  expectTypeOf(scanned.boxes).toEqualTypeOf<Boxes | undefined>()
  expectTypeOf(scanned.total).toEqualTypeOf<string | null>()
})

test('the README snippets compile', async () => {
  const eight = async (dm: DecisionMachine) => {
    const intent = await dm.classify(ticket, ['billing', 'shipping', 'account'])
    expectTypeOf(intent.label).toEqualTypeOf<'billing' | 'shipping' | 'account'>()

    const [urgent] = await dm.yesNo(
      ticket,
      ['The customer expresses urgency.', 'The customer is asking about shipping.'],
      { when_true: 'Time pressure, ASAP, losing money' },
    )
    expectTypeOf(urgent.answer).toEqualTypeOf<boolean>()
    expectTypeOf(urgent.statement).toEqualTypeOf<'The customer expresses urgency.'>()

    const tone = await dm.rate(message, ['Calm', 'Annoyed', 'Angry', 'Threatening to leave'])
    expectTypeOf(tone.score).toEqualTypeOf<number>()
    expectTypeOf(tone.level).toEqualTypeOf<0 | 1 | 2 | 3>()
    expectTypeOf(tone.label).toEqualTypeOf<'Calm' | 'Annoyed' | 'Angry' | 'Threatening to leave'>()

    const [who] = await dm.answer(article, ['Who announced the product?'])
    if (who.start !== null && who.end !== null) article.slice(who.start, who.end)

    const found = await dm.entities(article, {
      person: 'a human name',
      place: 'a city or country',
    })
    expectTypeOf(found[0]?.type).toEqualTypeOf<'person' | 'place' | undefined>()

    const check = await dm.verify(invoiceText, 'invoice_number', 4471)
    expectTypeOf(check.matches).toEqualTypeOf<boolean>()

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
    expectTypeOf(node.label).toEqualTypeOf<Leaf>()
    expectTypeOf(node.path).toEqualTypeOf<Every[]>()

    const invoice = await dm.extract(letter, {
      type: 'object',
      properties: {
        due_date: { description: 'the date the payment is due' },
        total: { type: 'number' },
      },
    })
    expectTypeOf(invoice.total).toEqualTypeOf<number | null>()
  }
  void eight

  const batching = async (dm: DecisionMachine) => {
    const one = await dm.classify(ticket, LABELS)
    expectTypeOf(one).toEqualTypeOf<ClassifyResult<Intent>>()
    const [a, b] = await dm.classify([t1, t4], LABELS)
    expectTypeOf(a).toEqualTypeOf<ClassifyResult<Intent>>()
    expectTypeOf(b).toEqualTypeOf<ClassifyResult<Intent>>()
    const many = await dm.classify(tickets, LABELS)
    expectTypeOf(many).toEqualTypeOf<ClassifyResult<Intent>[]>()
    const grid = await dm.yesNo([t1, t4], ['The text mentions a price.'])
    expectTypeOf(grid[0][0].answer).toEqualTypeOf<boolean>()
  }
  void batching

  const degradations = async (dm: DecisionMachine) => {
    const data = await dm.extract(letter, {
      type: 'object',
      properties: {
        reference: { type: 'string', enum: ['AB', 'CD'] },
        tags: { type: 'array', items: { type: 'string' } },
        line_items: { type: 'array', items: { type: 'object' } },
        vendor: { type: 'object', properties: { name: { type: 'string' } } },
      },
    })
    expectTypeOf(data.reference).toEqualTypeOf<'AB' | 'CD' | (string & {}) | null>()
    expectTypeOf(data.tags).toEqualTypeOf<string[] | null>()
    expectTypeOf(data.line_items).toEqualTypeOf<never[]>()
    expectTypeOf(data.vendor).toEqualTypeOf<{ name: string | null }>()
  }
  void degradations

  const usage = async (dm: DecisionMachine) => {
    const { result, usage: u, response } = await dm.classify(ticket, LABELS).withUsage()
    expectTypeOf(result).toEqualTypeOf<ClassifyResult<Intent>>()
    expectTypeOf(u.inputTokens).toEqualTypeOf<number>()
    expectTypeOf(u.inferenceMs).toEqualTypeOf<number>()
    expectTypeOf(u.rateLimit).toEqualTypeOf<RateLimit | null>()
    expectTypeOf(u.headers).toEqualTypeOf<Headers>()
    expectTypeOf(response).toEqualTypeOf<Response>()
  }
  void usage

  const errors = async (dm: DecisionMachine) => {
    try {
      await dm.classify(ticket, LABELS)
    } catch (e) {
      if (!isMillisecondsError(e)) throw e
      switch (e.code) {
        case 'rate_limit_exceeded':
          return wait(e.retryAfter)
        case 'insufficient_quota':
          return topUp()
        case 'invalid_request':
          return fix(e.apiMessage)
        default:
          throw e
      }
    }
  }
  void errors

  const escape = async (dm: DecisionMachine) => {
    const raw = await dm.post<unknown>('/v1/decision-machine-1/classify', {
      text: ticket,
      labels: LABELS,
    })
    expectTypeOf(raw).toEqualTypeOf<unknown>()
  }
  void escape

  const onWorkers = () =>
    new DecisionMachine({
      apiKey: workerEnv.MS_API_KEY,
      fetch: workerEnv.MILLISECONDS.fetch.bind(workerEnv.MILLISECONDS),
    })
  void onWorkers
})
