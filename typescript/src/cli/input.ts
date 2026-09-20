import { readFileSync } from 'node:fs'

import { UsageError } from './spec'

export interface Sources {
  /** `-f, --file`, in order. */
  files: string[]
  /** `--lines`: one text per line. */
  lines: string | undefined
  /** The positionals after the capability. */
  positionals: string[]
  /** All of stdin, read once and cached. */
  stdin: () => string
  stdinIsTty: boolean
  /** `--image` is set, so the text is optional and a positional is never the text. */
  hasImage?: boolean
}

export interface Resolved {
  /** One string for one call, an array for a batch. */
  input: string | string[]
  /** What is left for the capability's list. */
  items: string[]
  /** Piped JSON: the whole request body. Flags still override single keys. */
  body?: Record<string, unknown>
  /** One stderr line. The pipe took a text a positional could also have carried. */
  note?: string
}

/** One trailing newline is a file ending, not text. It would bill and print. */
function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').replace(/\r?\n$/, '')
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${(e as Error).message}`)
  }
}

const NO_TEXT = 'no text. Pass the text, or -f <file>, or --lines <file>, or pipe the text in.'

/** A @file and a name=description are list arguments. Anything else could be the text. */
const listOnly = (item: string) => item.startsWith('@') || item.includes('=')

/** The pipe wins over a positional, so say which argument lost the text. */
const shadowed = (first: string) =>
  `dm1: the text comes from stdin. "${first.length > 32 ? `${first.slice(0, 31)}…` : first}" is a list argument, not the text. Pass - to silence this.`

/**
 * One source only.
 *
 * `--file` and `--lines` win. A leading `-` reads stdin. A pipe that carries text reads
 * stdin, and every positional then belongs to the capability's list. Otherwise the first
 * positional is the text. No text anywhere is a usage error.
 */
export function resolveInput(s: Sources): Resolved {
  if (s.lines !== undefined) {
    const texts = readFile(s.lines)
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
    if (texts.length === 0) throw new UsageError(`${s.lines} holds no text.`)
    return { input: texts, items: s.positionals }
  }
  if (s.files.length > 0) {
    const texts = s.files.map(readFile)
    return { input: texts.length === 1 ? (texts[0] as string) : texts, items: s.positionals }
  }

  let items = s.positionals
  let explicit = false
  if (items[0] === '-') {
    explicit = true
    items = items.slice(1)
  }
  const raw = explicit || !s.stdinIsTty ? s.stdin() : ''
  const trimmed = raw.trim()
  if (trimmed === '') {
    // An image needs no text, and a positional beside one is a label, not the text.
    if (s.hasImage === true) return { input: '', items }
    // An empty pipe, /dev/null or a terminal: the positional text is the source.
    if (explicit) throw new UsageError('stdin is empty. Send the text in, or pass -f <file>.')
    if (items.length === 0) throw new UsageError(NO_TEXT)
    return { input: items[0] as string, items: items.slice(1) }
  }
  if (!trimmed.startsWith('{')) {
    const first = items[0]
    const quiet = explicit || first === undefined || listOnly(first)
    return {
      input: raw.replace(/\r?\n$/, ''),
      items,
      ...(quiet ? {} : { note: shadowed(first as string) }),
    }
  }

  // A docs curl body, pasted in. It becomes the whole request.
  let body: Record<string, unknown>
  try {
    body = JSON.parse(trimmed) as Record<string, unknown>
  } catch (e) {
    throw new UsageError(
      `stdin starts with { but is not JSON: ${(e as Error).message}. Fix the JSON, or send plain text with -f <file>.`,
    )
  }
  // The API answers 200 with {"results":[]} for a yes-no or answer body that has no text.
  // Nothing downstream can tell that apart from a real answer, so refuse it here.
  if (Array.isArray(body.texts)) {
    if (body.texts.length === 0)
      throw new UsageError('the piped body has an empty texts array. Send at least one text.')
    return { input: body.texts as string[], items, body }
  }
  if (typeof body.text !== 'string')
    throw new UsageError('the piped body has no text and no texts. Add one of them to the JSON.')
  return { input: body.text, items, body }
}

/** `--lines` and repeated `--file` chunk at 32, the API's batch limit. */
export const CHUNK = 32

export function chunk(texts: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < texts.length; i += CHUNK) out.push(texts.slice(i, i + CHUNK))
  return out
}
