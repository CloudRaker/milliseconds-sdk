import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import { run, type Io } from '../src/cli/run'

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

interface Sent {
  url: string
  body: Record<string, unknown>
}

/** A fetch that answers the given replies in order, repeating the last one. */
function stub(...replies: Reply[]) {
  const calls: Sent[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)] ?? {}
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    })
  })
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

interface Options {
  stdin?: string
  stdoutIsTty?: boolean
  env?: Record<string, string | undefined>
  replies?: Reply[]
}

/** argv in; the request bodies, stdout, stderr and the exit code out. */
async function cli(argv: string[], options: Options = {}) {
  const { calls, fetch } = stub(...(options.replies ?? [{ body: {} }]))
  const out: string[] = []
  const err: string[] = []
  // A real pipe that nobody writes to never ends. Counting the reads catches that.
  let reads = 0
  const io: Io = {
    argv,
    env: { MS_API_KEY: 'sk-ms-testnamespace-entropy', ...options.env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: async () => {
      reads += 1
      return options.stdin ?? ''
    },
    stdinIsTty: options.stdin === undefined,
    stdoutIsTty: options.stdoutIsTty === true,
    fetch,
  }
  const code = await run(io)
  return {
    code,
    out: out.join('\n'),
    err: err.join('\n'),
    calls,
    body: calls[0]?.body,
    reads: () => reads,
  }
}

const TICKET = 'I was charged twice.'

const classified = (label = 'billing') => ({
  body: {
    label,
    probability: 0.999,
    confidence: 0.995,
    scores: { billing: 0.999, shipping: 0.0, account: 0.001 },
  },
})

const HEADERS = {
  'x-input-chars': '79',
  'x-input-tokens': '20',
  'x-inference-ms': '381',
  'x-ratelimit-limit-requests': '200',
  'x-ratelimit-remaining-requests': '199',
  'x-ratelimit-reset-requests': '5m0s',
  'x-ratelimit-limit-tokens': '1000000',
  'x-ratelimit-remaining-tokens': '999980',
  'x-ratelimit-reset-tokens': '1m0s',
}

const dir = mkdtempSync(join(tmpdir(), 'dm1-'))
const file = (name: string, content: string) => {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('the request body', () => {
  test('classify sends text and labels', async () => {
    const { code, calls, body } = await cli(['classify', TICKET, 'billing', 'shipping'], {
      replies: [classified()],
    })
    expect(code).toBe(0)
    expect(calls[0]?.url).toBe('https://api.milliseconds.ai/v1/decision-machine-1/classify')
    expect(body).toEqual({ text: TICKET, labels: ['billing', 'shipping'] })
  })

  test('name=description becomes a label map', async () => {
    const { body } = await cli(['classify', TICKET, 'billing=charges', 'shipping'], {
      replies: [classified()],
    })
    expect(body).toEqual({ text: TICKET, labels: { billing: 'charges', shipping: '' } })
  })

  test('@file loads a label map', async () => {
    const path = file('labels.json', JSON.stringify({ billing: 'charges', shipping: 'parcels' }))
    const { body } = await cli(['classify', TICKET, `@${path}`], { replies: [classified()] })
    expect(body).toEqual({ text: TICKET, labels: { billing: 'charges', shipping: 'parcels' } })
  })

  test('yes-no sends statements and the hints', async () => {
    const { body, out } = await cli(
      ['yes-no', TICKET, 'The customer is angry.', '--when-true', 'anger'],
      { replies: [{ body: { results: [{ statement: 'x', answer: true, probability: 0.9 }] } }] },
    )
    expect(body).toEqual({
      text: TICKET,
      statements: ['The customer is angry.'],
      when_true: 'anger',
    })
    expect(JSON.parse(out)).toEqual([{ statement: 'x', answer: true, probability: 0.9 }])
  })

  test('rate sends the scale in order, = is never split', async () => {
    const { body } = await cli(['rate', TICKET, 'Calm', 'Angry=very'], {
      replies: [
        { body: { score: 1, level: 1, label: 'Angry=very', confidence: 0.7, scores: [0.3, 0.7] } },
      ],
    })
    expect(body).toEqual({ text: TICKET, scale: ['Calm', 'Angry=very'] })
  })

  test('answer sends questions and unwraps results', async () => {
    const { body, out } = await cli(['answer', TICKET, 'Who?'], {
      replies: [
        {
          body: {
            results: [{ question: 'Who?', answer: null, probability: 0, start: null, end: null }],
          },
        },
      ],
    })
    expect(body).toEqual({ text: TICKET, questions: ['Who?'] })
    expect(JSON.parse(out)).toHaveLength(1)
  })

  test('entities unwraps the entities envelope', async () => {
    const { body, out } = await cli(['entities', TICKET, 'person=a human name'], {
      replies: [
        {
          body: { entities: [{ type: 'person', text: 'Ada', probability: 0.9, start: 0, end: 3 }] },
        },
      ],
    })
    expect(body).toEqual({ text: TICKET, types: { person: 'a human name' } })
    expect(JSON.parse(out)).toEqual([
      { type: 'person', text: 'Ada', probability: 0.9, start: 0, end: 3 },
    ])
  })

  test('extract takes inline JSON and unwraps data', async () => {
    const schema = '{"type":"object","properties":{"total":{"type":"number"}}}'
    const { body, out } = await cli(['extract', TICKET, '--schema', schema], {
      replies: [{ body: { data: { total: 12 } } }],
    })
    expect(body).toEqual({ text: TICKET, schema: JSON.parse(schema) })
    expect(JSON.parse(out)).toEqual({ total: 12 })
  })

  test('verify splits field=description and sends value', async () => {
    const { body } = await cli(
      ['verify', TICKET, '--field', 'total=the amount due', '--value', '999'],
      { replies: [{ body: { matches: true, probability: 0.9, found: ['999'] } }] },
    )
    expect(body).toEqual({
      text: TICKET,
      field: { name: 'total', description: 'the amount due' },
      value: '999',
    })
  })

  test('classify-tree loads the tree from a file', async () => {
    const path = file('tree.json', JSON.stringify({ billing: 'a', shipping: 'b' }))
    const { body } = await cli(['classify-tree', TICKET, '--tree', `@${path}`], {
      replies: [
        {
          body: {
            path: ['billing'],
            label: 'billing',
            probability: 0.9,
            confidence: 0.8,
            levels: [],
          },
        },
      ],
    })
    expect(body).toEqual({ text: TICKET, tree: { billing: 'a', shipping: 'b' } })
  })

  test('check sends one small classify', async () => {
    const { code, calls, out } = await cli(['check'], {
      replies: [{ body: classified().body, headers: HEADERS }],
    })
    expect(code).toBe(0)
    expect(calls[0]?.body).toEqual({ text: 'ok', labels: ['yes', 'no'] })
    expect(JSON.parse(out)).toMatchObject({ key: 'sk-ms-testna…ropy' })
  })
})

describe('the text', () => {
  test('one --file sends text, two send texts', async () => {
    // The trailing newline of a text file is a file ending, never text.
    const a = file('a.txt', 'first\n')
    const b = file('b.txt', 'second\n')
    const one = await cli(['classify', '-f', a, 'billing', 'shipping'], { replies: [classified()] })
    expect(one.body).toEqual({ text: 'first', labels: ['billing', 'shipping'] })

    const two = await cli(['classify', '-f', a, '-f', b, 'billing', 'shipping'], {
      replies: [{ body: { results: [classified().body, classified().body] } }],
    })
    expect(two.body).toEqual({ texts: ['first', 'second'], labels: ['billing', 'shipping'] })
  })

  test('a pipe becomes the text and every positional is a label', async () => {
    const { body } = await cli(['classify', 'billing', 'shipping'], {
      stdin: 'piped ticket\n',
      replies: [classified()],
    })
    expect(body).toEqual({ text: 'piped ticket', labels: ['billing', 'shipping'] })
  })

  test('piped JSON becomes the whole request body, and a flag still wins', async () => {
    const { body, out } = await cli(['classify'], {
      stdin: '{"text":"from the docs","labels":["a","b"]}',
      replies: [classified('a')],
    })
    expect(body).toEqual({ text: 'from the docs', labels: ['a', 'b'] })
    expect(JSON.parse(out)).toMatchObject({ label: 'a' })

    const flagged = await cli(['classify', 'c', 'd'], {
      stdin: '{"text":"from the docs","labels":["a","b"]}',
      replies: [classified('c')],
    })
    expect(flagged.body).toEqual({ text: 'from the docs', labels: ['c', 'd'] })
  })

  test('piped JSON with texts unwraps the batch', async () => {
    const { out } = await cli(['classify'], {
      stdin: '{"texts":["one","two"],"labels":["a","b"]}',
      replies: [{ body: { results: [classified().body, classified().body] } }],
    })
    expect(JSON.parse(out)).toHaveLength(2)
  })

  test('broken piped JSON exits 2 and names both recoveries', async () => {
    const { code, err, calls } = await cli(['classify', 'a', 'b'], { stdin: '{"text":' })
    expect(code).toBe(2)
    expect(err).toContain('stdin starts with { but is not JSON')
    expect(err).toContain('-f <file>')
    expect(calls).toHaveLength(0)
  })

  test('no text and a terminal on stdin exits 2', async () => {
    const { code, err, calls } = await cli(['classify'])
    expect(code).toBe(2)
    expect(err).toContain('dm1: usage: no text.')
    expect(calls).toHaveLength(0)
  })
})

describe('batching', () => {
  test('--lines chunks at 32, in order', async () => {
    const path = file(
      'many.txt',
      `${Array.from({ length: 33 }, (_, i) => `line ${i}`).join('\n')}\n`,
    )
    const reply = (n: number) => ({
      body: { results: Array.from({ length: n }, () => classified().body) },
      headers: HEADERS,
    })
    const { code, calls, out } = await cli(['classify', '--lines', path, 'billing', 'shipping'], {
      replies: [reply(32), reply(1)],
    })
    expect(code).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body.texts as string[]).toHaveLength(32)
    expect(calls[1]?.body.texts as string[]).toEqual(['line 32'])
    expect(JSON.parse(out)).toHaveLength(33)
  })

  test('--usage sums every chunk and prints to stderr', async () => {
    const path = file('two.txt', 'one\ntwo\n')
    const { out, err } = await cli(['classify', '--lines', path, 'billing', 'shipping', '-v'], {
      replies: [{ body: { results: [classified().body, classified().body] }, headers: HEADERS }],
    })
    expect(err).toBe('usage: 79 chars, 20 tokens, 381 ms inference, 199/200 requests left')
    expect(out).not.toContain('usage:')
  })
})

describe('output', () => {
  test('a pipe gets JSON, a terminal gets the table', async () => {
    const piped = await cli(['classify', TICKET, 'billing', 'shipping', 'account'], {
      replies: [classified()],
    })
    expect(JSON.parse(piped.out)).toMatchObject({ label: 'billing' })

    const table = await cli(['classify', TICKET, 'billing', 'shipping', 'account', '--no-color'], {
      stdoutIsTty: true,
      replies: [classified()],
    })
    expect(table.out).toBe(
      [
        'label        billing',
        'probability  0.999',
        'confidence   0.995',
        '',
        'scores',
        `  billing    0.999  ${'█'.repeat(20)}`,
        '  account    0.001',
        '  shipping   0.000',
        '',
        '  Bare label names score worse. Try: billing="charges and refunds"',
      ].join('\n'),
    )
  })

  test('described labels drop the hint', async () => {
    const { out } = await cli(
      ['classify', TICKET, 'billing=charges', 'shipping=parcels', '--no-color'],
      {
        stdoutIsTty: true,
        replies: [classified()],
      },
    )
    expect(out).not.toContain('Bare label names')
  })

  test('--jsonl prints one line per text, with the text', async () => {
    const path = file('jsonl.txt', 'one\ntwo\n')
    const { out } = await cli(['classify', '--lines', path, 'billing', 'shipping', '--jsonl'], {
      replies: [{ body: { results: [classified().body, classified().body] } }],
    })
    const lines = out.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ text: 'one', label: 'billing' })
    expect(lines[1]).toMatchObject({ text: 'two' })
  })

  test('--jsonl keeps the input text when the result carries one', async () => {
    const { out } = await cli(
      ['extract', 'Mac Pro costs 6999.', '--schema', '{"type":"object","properties":{"text":{}}}'],
      { replies: [{ body: { data: { text: 'Mac Pro', price: 6999 } } }] },
    )
    expect(JSON.parse(out)).toEqual({ text: 'Mac Pro', price: 6999 })

    const jsonl = await cli(
      [
        'extract',
        'Mac Pro costs 6999.',
        '--schema',
        '{"type":"object","properties":{"text":{}}}',
        '--jsonl',
      ],
      { replies: [{ body: { data: { text: 'Mac Pro', price: 6999 } } }] },
    )
    expect(JSON.parse(jsonl.out)).toEqual({ text: 'Mac Pro costs 6999.', price: 6999 })
  })

  test('-q prints the primary value only', async () => {
    const { out } = await cli(['yes-no', TICKET, 'The customer is angry.', '-q'], {
      replies: [{ body: { results: [{ statement: 'x', answer: false, probability: 0.1 }] } }],
    })
    expect(out).toBe('no')
  })

  test('--raw keeps the envelope', async () => {
    const { out } = await cli(['entities', TICKET, 'person', '--raw'], {
      replies: [
        {
          body: { entities: [{ type: 'person', text: 'Ada', probability: 0.9, start: 0, end: 3 }] },
        },
      ],
    })
    expect(JSON.parse(out)).toEqual({
      entities: [{ type: 'person', text: 'Ada', probability: 0.9, start: 0, end: 3 }],
    })
  })
})

describe('exit codes', () => {
  test('a client-side check exits 2, sends nothing and prints the example', async () => {
    const { code, err, calls } = await cli(['classify', TICKET, 'billing'])
    expect(code).toBe(2)
    expect(err).toContain('dm1: client_error: labels has 1 entry. classify needs 2 to 64.')
    expect(err).toContain('dm1 classify "I was charged twice." billing="charges and refunds"')
    expect(calls).toHaveLength(0)
  })

  test('an unknown flag exits 2', async () => {
    const { code, err, calls } = await cli(['classify', TICKET, 'billing', 'shipping', '--nope'])
    expect(code).toBe(2)
    expect(err).toContain('dm1: usage:')
    expect(calls).toHaveLength(0)
  })

  test('--check on a capability without an answer exits 2', async () => {
    const { code, err } = await cli(['classify', TICKET, 'billing', 'shipping', '--check'])
    expect(code).toBe(2)
    expect(err).toContain('--check works with yes-no and verify only')
  })

  test('an API refusal exits 1', async () => {
    const { code, err } = await cli(['classify', TICKET, 'billing', 'shipping'], {
      replies: [
        {
          status: 401,
          body: { error: { code: 'invalid_api_key', message: 'Incorrect API key provided.' } },
        },
      ],
    })
    expect(code).toBe(1)
    expect(err).toContain('dm1: invalid_api_key:')
  })

  test('--check exits 3 on a no, and still prints', async () => {
    const { code, out } = await cli(
      ['yes-no', TICKET, 'The reply promises a refund.', '--check', '-q'],
      {
        replies: [{ body: { results: [{ statement: 'x', answer: false, probability: 0.95 }] } }],
      },
    )
    expect(out).toBe('no')
    expect(code).toBe(3)
  })

  test('--min exits 3 below the threshold', async () => {
    const low = {
      body: {
        label: 'billing',
        probability: 0.5,
        confidence: 0.9,
        scores: { billing: 0.5, shipping: 0.5 },
      },
    }
    const under = await cli(['classify', TICKET, 'billing', 'shipping', '--min', '0.9'], {
      replies: [low],
    })
    expect(under.code).toBe(3)
    const over = await cli(['classify', TICKET, 'billing', 'shipping', '--min', '0.4'], {
      replies: [low],
    })
    expect(over.code).toBe(0)
  })

  test('--min-confidence exits 3 below the threshold', async () => {
    const { code } = await cli(
      ['classify', TICKET, 'billing', 'shipping', '--min-confidence', '0.999'],
      {
        replies: [classified()],
      },
    )
    expect(code).toBe(3)
  })

  test('a chunk that fails after a printed chunk names the chunk', async () => {
    const path = file(
      'fail.txt',
      `${Array.from({ length: 33 }, (_, i) => `line ${i}`).join('\n')}\n`,
    )
    const { code, out, err } = await cli(['classify', '--lines', path, 'billing', 'shipping'], {
      replies: [
        { body: { results: Array.from({ length: 32 }, () => classified().body) } },
        { status: 400, body: { error: { code: 'invalid_request', message: 'nope' } } },
      ],
    })
    expect(code).toBe(1)
    expect(JSON.parse(out)).toHaveLength(32)
    expect(err).toContain('chunk 2 of 2 (texts 33-33) failed')
  })
})

const many = (n: number) => `${Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')}\n`

describe('a failed chunk', () => {
  test('--jsonl prints every row once and still reports the usage', async () => {
    const path = file('jsonl-fail.txt', many(33))
    const { code, out, err } = await cli(
      ['classify', '--lines', path, 'billing', 'shipping', '--jsonl', '-v'],
      {
        replies: [
          {
            body: { results: Array.from({ length: 32 }, () => classified().body) },
            headers: HEADERS,
          },
          { status: 400, body: { error: { code: 'invalid_request', message: 'nope' } } },
        ],
      },
    )
    expect(code).toBe(1)
    expect(out.split('\n')).toHaveLength(32)
    expect(err).toContain('chunk 2 of 2')
    expect(err).toContain('usage: 79 chars')
  })

  test('a client-side check inside a batch exits 2 and sends nothing more', async () => {
    const path = file('poison.txt', `${many(32)}${'x'.repeat(20_001)}\n`)
    const { code, err, calls } = await cli(['classify', '--lines', path, 'billing', 'shipping'], {
      replies: [{ body: { results: Array.from({ length: 32 }, () => classified().body) } }],
    })
    expect(code).toBe(2)
    expect(err).toContain('20,001 characters')
    expect(err).not.toContain('chunk 2 of 2')
    expect(calls).toHaveLength(1)
  })
})

describe('help', () => {
  test('dm1 --help prints the usage block and exits 0', async () => {
    const { code, out } = await cli(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('dm1 — typed decisions over text, from milliseconds.ai')
    expect(out).toContain('  dm1 <capability> [text] [args...] [options]')
  })

  test('no arguments print the same block', async () => {
    const { code, out } = await cli([])
    expect(code).toBe(0)
    expect(out).toContain('CAPABILITIES')
  })

  test('a capability help prints its own block', async () => {
    const { code, out } = await cli(['classify', '--help'])
    expect(code).toBe(0)
    expect(out).toContain('  dm1 classify [text] <label[=description]>... [options]')
    expect(out).toContain('  POST /v1/decision-machine-1/classify')
  })

  test('check has its own help', async () => {
    const { out } = await cli(['check', '--help'])
    expect(out).toContain('It sends one small classify, about 20 tokens.')
  })

  test('no key exits 2 with the shell answer', async () => {
    const { code, err, calls } = await cli(['classify', TICKET, 'billing', 'shipping'], {
      env: { MS_API_KEY: undefined },
    })
    expect(code).toBe(2)
    expect(err).toContain('dm1: usage: no API key. Run export MS_API_KEY=sk-ms-...')
    expect(calls).toHaveLength(0)
  })

  test('an unknown capability exits 2', async () => {
    const { code, err } = await cli(['sentiment', 'x'])
    expect(code).toBe(2)
    expect(err).toContain('unknown capability sentiment')
  })

  test('-V prints the version', async () => {
    const { code, out } = await cli(['-V'])
    expect(code).toBe(0)
    expect(out).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('the pipe', () => {
  test('a piped body with no text exits 2 and sends nothing', async () => {
    const { code, err, calls } = await cli(['yes-no'], {
      stdin: '{"statement":"The customer is angry."}',
    })
    expect(code).toBe(2)
    expect(err).toContain('the piped body has no text and no texts')
    expect(calls).toHaveLength(0)
  })

  test('a piped body with an empty texts array exits 2', async () => {
    const { code, err, calls } = await cli(['classify'], {
      stdin: '{"texts":[],"labels":["a","b"]}',
    })
    expect(code).toBe(2)
    expect(err).toContain('empty texts array')
    expect(calls).toHaveLength(0)
  })

  test('the positional list wins over the body singular', async () => {
    const { code, body } = await cli(['yes-no', 'The text mentions money.'], {
      stdin: '{"text":"Fix this today.","statement":"The customer expresses urgency."}',
      replies: [{ body: { results: [{ statement: 'x', answer: true, probability: 0.9 }] } }],
    })
    expect(code).toBe(0)
    expect(body).toEqual({ text: 'Fix this today.', statements: ['The text mentions money.'] })
  })

  test('a shadowed positional prints one stderr line, stdout stays clean', async () => {
    const { code, err, out, body } = await cli(['classify', 'billing', 'shipping'], {
      stdin: 'unrelated pipe content\n',
      replies: [classified()],
    })
    expect(code).toBe(0)
    expect(err).toBe(
      'dm1: the text comes from stdin. "billing" is a list argument, not the text. Pass - to silence this.',
    )
    expect(body).toEqual({ text: 'unrelated pipe content', labels: ['billing', 'shipping'] })
    expect(out).not.toContain('dm1:')
  })

  test('a @file, a described label and an explicit - stay quiet', async () => {
    const path = file('quiet.json', JSON.stringify(['a', 'b']))
    const loaded = await cli(['classify', `@${path}`], {
      stdin: 'piped\n',
      replies: [classified('a')],
    })
    expect(loaded.err).toBe('')
    const described = await cli(['classify', 'billing=charges', 'shipping=parcels'], {
      stdin: 'piped\n',
      replies: [classified()],
    })
    expect(described.err).toBe('')
    const dash = await cli(['classify', '-', 'billing', 'shipping'], {
      stdin: 'piped\n',
      replies: [classified()],
    })
    expect(dash.err).toBe('')
  })

  test('help, check, --file and --lines never read stdin', async () => {
    const path = file('nostdin.txt', 'a ticket\n')
    const help = await cli(['classify', '--help'], { stdin: 'never read' })
    expect(help.reads()).toBe(0)
    const checked = await cli(['check', '--help'], { stdin: 'never read' })
    expect(checked.reads()).toBe(0)
    const filed = await cli(['classify', '-f', path, 'billing', 'shipping'], {
      stdin: 'never read',
      replies: [classified()],
    })
    expect(filed.reads()).toBe(0)
    expect(filed.body).toEqual({ text: 'a ticket', labels: ['billing', 'shipping'] })
    const lined = await cli(['classify', '--lines', path, 'billing', 'shipping'], {
      stdin: 'never read',
      replies: [{ body: { results: [classified().body] } }],
    })
    expect(lined.reads()).toBe(0)
  })
})

describe('the predicates', () => {
  test('an empty result list fails --check', async () => {
    const { code } = await cli(['yes-no', TICKET, 'The customer is angry.', '--check', '-q'], {
      replies: [{ body: { results: [] } }],
    })
    expect(code).toBe(3)
  })

  test('--min and --min-confidence exit 2 where the field does not exist', async () => {
    const rated = await cli(['rate', TICKET, 'Calm', 'Angry', '--min', '0.99'])
    expect(rated.code).toBe(2)
    expect(rated.err).toContain('--min reads a probability. A rate result carries none.')
    const asked = await cli(['yes-no', TICKET, 'The text is angry.', '--min-confidence', '0.99'])
    expect(asked.code).toBe(2)
    expect(asked.err).toContain('--min-confidence reads a confidence')
    const extracted = await cli(['extract', TICKET, '--schema', '{}', '--min', '0.9'])
    expect(extracted.code).toBe(2)
  })
})

describe('the list', () => {
  test('a name-to-description @file on rate exits 2 instead of dropping the scale', async () => {
    const path = file('scale.json', JSON.stringify({ Calm: 'no complaint', Angry: 'hostility' }))
    const { code, err, calls } = await cli(['rate', TICKET, `@${path}`])
    expect(code).toBe(2)
    expect(err).toContain('yes-no, rate and answer take a JSON array')
    expect(calls).toHaveLength(0)
  })
})

// ---- images ---------------------------------------------------------------

describe('--image', () => {
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  const pngFile = () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dm1-cli-')), 'pixel.png')
    writeFileSync(path, Buffer.from(PNG_BASE64, 'base64'))
    return path
  }

  test('sends the file as base64, and every positional stays a label', async () => {
    const r = await cli(
      ['classify', '--image', pngFile(), '--detail', 'low', 'receipt', 'invoice'],
      {
        replies: [classified('receipt')],
      },
    )
    expect(r.code).toBe(0)
    expect(r.body).toEqual({ labels: ['receipt', 'invoice'], detail: 'low', image: PNG_BASE64 })
  })

  test('a piped text joins the image', async () => {
    const r = await cli(['classify', '--image', pngFile(), 'receipt', 'invoice'], {
      stdin: 'the scan of a till receipt',
      replies: [classified('receipt')],
    })
    expect(r.body).toEqual({
      text: 'the scan of a till receipt',
      labels: ['receipt', 'invoice'],
      image: PNG_BASE64,
    })
  })

  test('an unknown detail tier is a usage error', async () => {
    const r = await cli(['classify', '--image', pngFile(), '--detail', 'ultra', 'a', 'b'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('--detail takes low, medium, high')
  })

  test('a missing file is a usage error, not a request', async () => {
    const r = await cli(['classify', '--image', '/no/such/file.png', 'a', 'b'])
    expect(r.code).toBe(2)
    expect(r.calls).toHaveLength(0)
  })

  test('a file that is not a JPEG, PNG or WebP never reaches the wire', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dm1-cli-')), 'notes.txt')
    writeFileSync(path, 'plain text, not an image')
    const r = await cli(['classify', '--image', path, 'a', 'b'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('data:image/')
    expect(r.calls).toHaveLength(0)
    // The piped-body path builds the request itself, so it is checked too.
    const piped = await cli(['classify', '--image', path, 'a', 'b'], {
      stdin: JSON.stringify({ text: 'hi' }),
    })
    expect(piped.code).toBe(2)
    expect(piped.calls).toHaveLength(0)
  })
})
