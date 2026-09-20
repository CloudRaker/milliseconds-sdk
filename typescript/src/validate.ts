import { clientError } from './errors'

import type { Input } from './types'

const MAX_CHARS = 20_000
const MAX_TEXTS = 32
const MAX_ITEMS = 32

const n = (x: number) => x.toLocaleString('en-US')
const count = (size: number) => (size === 1 ? '1 entry' : `${n(size)} entries`)

/** The key is a secret, so a browser bundle needs an explicit opt-in. */
export function checkRuntime(
  apiKey: string | undefined,
  allowBrowser: boolean | undefined,
): asserts apiKey is string {
  if (!apiKey)
    throw clientError(
      'No API key. Pass new DecisionMachine({ apiKey }) or set MS_API_KEY. Get a key at https://console.milliseconds.ai.',
    )
  const browser =
    typeof globalThis === 'object' &&
    typeof (globalThis as { document?: { createElement?: unknown } }).document?.createElement ===
      'function'
  if (browser && !allowBrowser)
    throw clientError(
      'The API key is a secret. Call the API from your server, or pass dangerouslyAllowBrowser: true when the bundle never reaches a user.',
    )
}

/**
 * `texts` is 1 to 32 items, and every text is 1 to 20,000 characters.
 *
 * An empty text is a 400, not the 200-with-empty-results trap. That trap needs `text` and
 * `texts` both absent, and the SDK always sends one of them. This check only replaces a
 * round trip with a local error.
 *
 * An image call may carry no text at all, so `hasImage` allows the empty string. The
 * body then holds `image` and no `text`.
 */
export function checkInput(input: Input, hasImage = false): void {
  if (typeof input === 'string') {
    if (input === '' && !hasImage) throw empty('text')
    if (input.length > MAX_CHARS) throw tooLong('text', input.length)
    return
  }
  if (input.length === 0) throw clientError('texts is empty. Send at least one text.')
  if (input.length > MAX_TEXTS)
    throw clientError(
      `texts has ${n(input.length)} items. The limit is ${n(MAX_TEXTS)}. Split the batch.`,
    )
  for (const [i, text] of input.entries()) {
    if (text === '') throw empty(`texts[${i}]`)
    if (text.length > MAX_CHARS) throw tooLong(`texts[${i}]`, text.length)
  }
}

const empty = (where: string) => clientError(`${where} is empty. Send at least one character.`)

const tooLong = (where: string, length: number) =>
  clientError(
    `${where} is ${n(length)} characters. The limit is ${n(MAX_CHARS)}. Split on paragraphs and send the parts as texts.`,
  )

/**
 * `statements` and `questions` are 1 to 32 items. The wire message for a body without one
 * is `provide statement or statements, not both`, which names both fields and misleads.
 */
export function checkSpec(
  name: 'statements' | 'questions',
  value: string | readonly string[],
): void {
  if (typeof value === 'string') {
    if (value !== '') return
    if (name === 'statements')
      throw clientError(
        'yes-no needs a statement. The wire message for a body without one names both fields and misleads.',
      )
    throw clientError(`${name} has 0 items. Send 1 to ${MAX_ITEMS}.`)
  }
  if (value.length === 0 || value.length > MAX_ITEMS)
    throw clientError(`${name} has ${n(value.length)} items. Send 1 to ${MAX_ITEMS}.`)
}

/**
 * `labels` is 2 to 64, `types` is 1 to 64 and `scale` is 2 to 10. Three limits, because
 * `decide.schema.ts` holds three. One shared rule would reject a legal single-type
 * `entities` call.
 *
 * `decide.schema.ts` bounds the array branch of `labels` and `types` only: the
 * `name -> description` branch is a plain `z.record`, so any number of described labels is
 * legal. `classify-tree` passes `bounded` because its own `superRefine` bounds every level.
 */
export function checkList(
  name: 'labels' | 'types' | 'scale',
  value: object,
  min: number,
  max: number,
  capability: string,
  bounded = Array.isArray(value),
): void {
  const size = Array.isArray(value) ? value.length : Object.keys(value).length
  if (bounded ? size >= min && size <= max : size > 0) return
  const found = size === 0 ? `${name} is empty.` : `${name} has ${count(size)}.`
  throw clientError(`${found} ${capability} needs ${min} to ${max}.`)
}

/** `planFor` throws unless the schema is an object with properties. Beat it locally. */
export function checkSchema(schema: unknown): void {
  const s = schema as { type?: unknown; properties?: unknown } | null
  const type = Array.isArray(s?.type) ? (s.type as unknown[]).find((t) => t !== 'null') : s?.type
  if (type !== 'object' || typeof s?.properties !== 'object' || s.properties === null)
    throw clientError('The schema must be an object with properties.')
}
