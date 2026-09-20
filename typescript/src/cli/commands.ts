import { encodeImage } from '../image'
import { readFileSync } from 'node:fs'
import { columns, int, kv, num, p3, scores, text, type Row } from './print'
import { loadDocument, specSize, UsageError, type SpecList } from './spec'

import type { Decision, DecisionMachine, Detail, ImageOptions, JsonSchema, Tree } from '../index'

/** The flags, for node:util parseArgs. */
export const OPTIONS = {
  json: { type: 'boolean' },
  jsonl: { type: 'boolean' },
  raw: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  check: { type: 'boolean' },
  min: { type: 'string' },
  'min-confidence': { type: 'string' },
  key: { type: 'string' },
  'base-url': { type: 'string' },
  retries: { type: 'string' },
  timeout: { type: 'string' },
  usage: { type: 'boolean', short: 'v' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  file: { type: 'string', short: 'f', multiple: true },
  lines: { type: 'string' },
  schema: { type: 'string' },
  tree: { type: 'string' },
  field: { type: 'string' },
  value: { type: 'string' },
  'when-true': { type: 'string' },
  'when-false': { type: 'string' },
  image: { type: 'string' },
  detail: { type: 'string' },
} as const

/** Derived from OPTIONS, so a renamed flag breaks the build instead of reading undefined. */
export type Values = Partial<{
  [K in keyof typeof OPTIONS]: (typeof OPTIONS)[K] extends { multiple: true }
    ? string[]
    : (typeof OPTIONS)[K] extends { type: 'boolean' }
      ? boolean
      : string
}>

export interface Call {
  dm: DecisionMachine
  input: string | string[]
  list: SpecList
  v: Values
  stdin: () => string
}

export interface Capability {
  name: string
  /** `name=description` positionals. yes-no, answer and rate take free text instead. */
  described: boolean
  /** The single-key envelope the API wraps one text's result in. */
  envelope: 'results' | 'entities' | 'data' | null
  /** `--check` reads a yes or no. Only yes-no and verify have one. */
  checkable: boolean
  /** The result carries `probability`, so `--min` can gate on it. */
  probability: boolean
  /** The result carries `confidence`, so `--min-confidence` can gate on it. */
  confidence: boolean
  help: string
  /** The first example. It prints under a usage error. */
  hint: string
  call(c: Call): Decision<unknown>
  /** The body keys the flags carry, for a request body piped in on stdin. */
  fragment(c: Call): Record<string, unknown>
  table(r: unknown, dim: (s: string) => string, names: string[]): string
  quiet(r: unknown): string[]
}

const need = (v: string | undefined, flag: string, example: string): string => {
  if (v === undefined || v === '')
    throw new UsageError(`${flag} is required. For example: ${example}`)
  return v
}

const list = (l: SpecList): string[] => (Array.isArray(l) ? l : Object.keys(l))

const asRow = (r: unknown) => r as Row
const asRows = (r: unknown) => r as Row[]

/** `field` takes a bare name or `name=description`. The SDK sends `{ name }` for a bare one. */
function fieldOf(raw: string): string | { name: string; description: string } {
  const at = raw.indexOf('=')
  return at > 0 ? { name: raw.slice(0, at), description: raw.slice(at + 1) } : raw
}

const span = (r: Row) => (r.start === null ? '' : `${num(r, 'start')}-${num(r, 'end')}`)

const DETAILS = ['low', 'medium', 'high']

/**
 * `--image <path>` and `--detail`, as the SDK options and as request-body keys. The two
 * shapes are the same: `image` and `detail` are the wire names.
 */
function image(c: Call): ImageOptions {
  if (c.v.detail !== undefined && !DETAILS.includes(c.v.detail))
    throw new UsageError(`--detail takes ${DETAILS.join(', ')}, not ${c.v.detail}.`)
  if (c.v.image === undefined) return {}
  let encoded: string
  try {
    // Bare base64: the SDK's own check below names a wrong format the same way as before.
    encoded = readFileSync(c.v.image).toString('base64')
  } catch (e) {
    throw new UsageError(`cannot read ${c.v.image}: ${(e as Error).message}`)
  }
  try {
    // The SDK's own check. A piped body goes straight to `dm.post`, which never calls it,
    // so both paths reject a bad or oversized file here instead of uploading it.
    encodeImage(encoded)
  } catch (e) {
    throw new UsageError(`${c.v.image}: ${(e as Error).message}`)
  }
  return {
    image: encoded,
    ...(c.v.detail === undefined ? {} : { detail: c.v.detail as Detail }),
  }
}

export const HELP = `dm1 — typed decisions over text, from milliseconds.ai

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

IMAGES
  --image <path>      One JPEG, PNG or WebP, at most 5 MB. Every capability takes one.
                      The positionals then stay list arguments, so send text beside the
                      image with -f <file> or a pipe.
  --detail <tier>     low (512 px), medium (768 px, default) or high (1024 px). It sets
                      the resolution and the billed image tokens.

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
  --raw               Print the result with its API envelope.
  -q, --quiet         Print the primary value only.
  --check             yes-no and verify only. Exit 3 when the answer is no.
  --min <p>           Exit 3 when probability is below <p>. Not rate or extract.
  --min-confidence <c>  Exit 3 when confidence is below <c>. classify, rate and
                        classify-tree only.
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
  dm1 classify --image receipt.jpg --detail low invoice receipt letter
  dm1 extract --image receipt.jpg --schema @receipt.json --json
  pbpaste | dm1 classify @labels.json

  No key yet?  https://console.milliseconds.ai  then  export MS_API_KEY=sk-ms-...
`

export const CHECK_HELP = `
  dm1 check [options]

  Tests the key and prints the limits. It sends one small classify, about 20 tokens.
  Do not run it in a health-check loop.

  EXAMPLES
    dm1 check
    dm1 check --base-url https://api.milliseconds.ai --key sk-ms-...
`

export const CAPABILITIES: Record<string, Capability> = {
  classify: {
    name: 'classify',
    described: true,
    envelope: null,
    checkable: false,
    probability: true,
    confidence: true,
    hint: 'dm1 classify "I was charged twice." billing="charges and refunds" shipping="delivery"',
    help: `
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
`,
    call: (c) => c.dm.classify(c.input, c.list, image(c)),
    fragment: (c) => ({ ...(specSize(c.list) > 0 ? { labels: c.list } : {}), ...image(c) }),
    table: (r, dim) => {
      const o = asRow(r)
      return `${kv(
        [
          ['label', text(o, 'label')],
          ['probability', p3(num(o, 'probability'))],
          ['confidence', p3(num(o, 'confidence'))],
        ],
        dim,
      )}\n\n${scores(Object.entries(o.scores as Record<string, number>), dim, true)}`
    },
    quiet: (r) => [text(asRow(r), 'label')],
  },

  'yes-no': {
    name: 'yes-no',
    described: false,
    envelope: 'results',
    checkable: true,
    probability: true,
    confidence: false,
    hint: 'dm1 yes-no "Fix this today." "The customer expresses urgency."',
    help: `
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
`,
    call: (c) =>
      c.dm.yesNo(c.input, list(c.list), {
        ...image(c),
        ...(c.v['when-true'] === undefined ? {} : { when_true: c.v['when-true'] }),
        ...(c.v['when-false'] === undefined ? {} : { when_false: c.v['when-false'] }),
      }),
    fragment: (c) => ({
      // A piped body may carry `statement`. Both keys at once is a 400, so the flag wins.
      ...(specSize(c.list) > 0 ? { statements: list(c.list), statement: undefined } : {}),
      ...(c.v['when-true'] === undefined ? {} : { when_true: c.v['when-true'] }),
      ...(c.v['when-false'] === undefined ? {} : { when_false: c.v['when-false'] }),
      ...image(c),
    }),
    table: (r) =>
      columns(
        asRows(r).map((o) => [
          o.answer === true ? 'yes' : 'no',
          p3(num(o, 'probability')),
          text(o, 'statement'),
        ]),
      ),
    quiet: (r) => asRows(r).map((o) => (o.answer === true ? 'yes' : 'no')),
  },

  rate: {
    name: 'rate',
    described: false,
    envelope: null,
    checkable: false,
    probability: false,
    confidence: true,
    hint: 'dm1 rate "I am done with this company." Calm Annoyed Angry "Threatening to leave"',
    help: `
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
`,
    call: (c) => c.dm.rate(c.input, list(c.list), image(c)),
    fragment: (c) => ({ ...(specSize(c.list) > 0 ? { scale: list(c.list) } : {}), ...image(c) }),
    table: (r, dim, names) => {
      const o = asRow(r)
      const scale = (o.scores as number[]).map(
        (p, i) => [names[i] ?? `${i}`, p] as [string, number],
      )
      return `${kv(
        [
          ['label', text(o, 'label')],
          ['score', num(o, 'score').toFixed(2)],
          ['level', text(o, 'level')],
          ['confidence', p3(num(o, 'confidence'))],
        ],
        dim,
      )}\n\n${scores(scale, dim, false)}`
    },
    quiet: (r) => [text(asRow(r), 'label')],
  },

  answer: {
    name: 'answer',
    described: false,
    envelope: 'results',
    checkable: false,
    probability: true,
    confidence: false,
    hint: 'dm1 answer -f press.txt "Who announced the product?" "How much does it cost?"',
    help: `
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
`,
    call: (c) => c.dm.answer(c.input, list(c.list), image(c)),
    fragment: (c) =>
      // A piped body may carry `question`. Both keys at once is a 400, so the flag wins.
      specSize(c.list) > 0
        ? { questions: list(c.list), question: undefined, ...image(c) }
        : { ...image(c) },
    table: (r) =>
      columns(
        asRows(r).map((o) => [
          o.answer === null ? '-' : text(o, 'answer'),
          p3(num(o, 'probability')),
          span(o),
          text(o, 'question'),
        ]),
      ),
    quiet: (r) => asRows(r).map((o) => (o.answer === null ? '' : text(o, 'answer'))),
  },

  entities: {
    name: 'entities',
    described: true,
    envelope: 'entities',
    checkable: false,
    probability: true,
    confidence: false,
    hint: 'dm1 entities "Ada met Grace in Paris." person="a human name" place="a city or country"',
    help: `
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
`,
    call: (c) => c.dm.entities(c.input, c.list, image(c)),
    fragment: (c) => ({ ...(specSize(c.list) > 0 ? { types: c.list } : {}), ...image(c) }),
    table: (r) =>
      columns(
        asRows(r).map((o) => [
          text(o, 'type'),
          text(o, 'text'),
          p3(num(o, 'probability')),
          span(o),
        ]),
      ),
    quiet: (r) => asRows(r).map((o) => text(o, 'text')),
  },

  extract: {
    name: 'extract',
    described: true,
    envelope: 'data',
    checkable: false,
    probability: false,
    confidence: false,
    hint: 'dm1 extract -f invoice.txt --schema @invoice.json --json > invoice.json',
    help: `
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
`,
    call: (c) =>
      c.dm.extract(
        c.input,
        loadDocument(
          'schema',
          need(c.v.schema, '--schema', 'dm1 extract -f invoice.txt --schema @invoice.json'),
          c.stdin,
        ) as JsonSchema,
        image(c),
      ),
    fragment: (c) =>
      c.v.schema === undefined
        ? { ...image(c) }
        : { schema: loadDocument('schema', c.v.schema, c.stdin), ...image(c) },
    table: (r) =>
      columns(
        Object.entries(asRow(r)).map(([k, v]) => [
          k,
          v === null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v),
        ]),
      ),
    quiet: (r) => [JSON.stringify(r)],
  },

  verify: {
    name: 'verify',
    described: false,
    envelope: null,
    checkable: true,
    probability: true,
    confidence: false,
    hint: 'dm1 verify -f invoice.txt --field total --value 999 --json | jq .found',
    help: `
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
    dm1 verify -f invoice.txt --field invoice_number="the identifier printed on the invoice" \\
      --value 4471 --check
    dm1 verify -f invoice.txt --field total --value 999 --json | jq .found
`,
    call: (c) =>
      c.dm.verify(
        c.input,
        fieldOf(need(c.v.field, '--field', 'dm1 verify -f invoice.txt --field total --value 999')),
        need(c.v.value, '--value', 'dm1 verify -f invoice.txt --field total --value 999'),
        image(c),
      ),
    fragment: (c) => ({
      ...(c.v.field === undefined ? {} : { field: fieldOf(c.v.field) }),
      ...(c.v.value === undefined ? {} : { value: c.v.value }),
      ...image(c),
    }),
    table: (r, dim) => {
      const o = asRow(r)
      return kv(
        [
          ['matches', o.matches === true ? 'yes' : 'no'],
          ['probability', p3(num(o, 'probability'))],
          ['found', (o.found as string[]).join(', ')],
        ],
        dim,
      )
    },
    quiet: (r) => [asRow(r).matches === true ? 'yes' : 'no'],
  },

  'classify-tree': {
    name: 'classify-tree',
    described: false,
    envelope: null,
    checkable: false,
    probability: true,
    confidence: true,
    hint: 'dm1 classify-tree -f ticket.txt --tree @taxonomy.json --json',
    help: `
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
`,
    call: (c) =>
      c.dm.classifyTree(
        c.input,
        loadDocument(
          'tree',
          need(c.v.tree, '--tree', 'dm1 classify-tree -f ticket.txt --tree @taxonomy.json'),
          c.stdin,
        ) as Tree,
        image(c),
      ),
    fragment: (c) =>
      c.v.tree === undefined
        ? { ...image(c) }
        : { tree: loadDocument('tree', c.v.tree, c.stdin), ...image(c) },
    table: (r, dim) => {
      const o = asRow(r)
      const levels = o.levels as Row[]
      const head = kv(
        [
          ['label', text(o, 'label')],
          ['path', (o.path as string[]).join(' > ')],
          ['probability', p3(num(o, 'probability'))],
          ['confidence', p3(num(o, 'confidence'))],
        ],
        dim,
      )
      const body = columns(
        levels.map((l, i) => [
          `  ${i + 1}`,
          text(l, 'label'),
          p3(num(l, 'probability')),
          p3(num(l, 'confidence')),
          `${int(num(l, 'inference_ms'))} ms`,
        ]),
      )
      return `${head}\n\n${dim('levels')}\n${body}`
    },
    quiet: (r) => [text(asRow(r), 'label')],
  },
}
