import { parseArgs } from 'node:util'

import { DecisionMachine, isMillisecondsError, type RateLimit, type Usage } from '../index'
import { CAPABILITIES, CHECK_HELP, HELP, OPTIONS, type Capability, type Values } from './commands'
import { CHUNK, chunk, resolveInput } from './input'
import { dimmer, int, kv } from './print'
import { parseSpec, UsageError } from './spec'

// ponytail: bumped by hand beside package.json, like the SDK's user-agent.
const VERSION = '0.2.1'

/** Everything the CLI touches outside itself. The tests pass their own. */
export interface Io {
  argv: string[]
  env: Record<string, string | undefined>
  out(line: string): void
  err(line: string): void
  stdin(): Promise<string>
  stdinIsTty: boolean
  stdoutIsTty: boolean
  fetch?: typeof globalThis.fetch
}

type Mode = 'table' | 'json' | 'jsonl' | 'raw' | 'quiet'
type Envelope = Capability['envelope']

interface Decided {
  text: string
  result: unknown
  raw: unknown
}

const path = (name: string) => `/v1/decision-machine-1/${name}`

const wrapOne = (v: unknown, env: Envelope): unknown =>
  env === null
    ? v
    : env === 'results'
      ? { results: v }
      : env === 'entities'
        ? { entities: v }
        : { data: v }

const unwrapOne = (raw: unknown, env: Envelope): unknown =>
  env === null ? raw : (raw as Record<string, unknown>)[env]

const number = (flag: string, raw: string): number => {
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new UsageError(`${flag} takes a number, not ${raw}.`)
  return n
}

/** Every result of one text: the object itself, or each element of a list. */
const items = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : [result as Record<string, unknown>]

/** `dm1: <code>: <message>` on stderr, then the capability's first example. */
function fail(io: Io, e: unknown, cap: Capability | undefined): number {
  const hint = () => {
    if (cap) io.err(`\n  ${cap.hint}`)
  }
  if (e instanceof UsageError) {
    io.err(`dm1: usage: ${e.message}`)
    hint()
    return 2
  }
  if (isMillisecondsError(e)) {
    io.err(`dm1: ${e.code}: ${e.message}`)
    // Nothing was sent, so this is bad usage, not an API failure.
    const local = e.status === 0 && (e.code === 'client_error' || e.code === 'invalid_schema')
    if (local) hint()
    return local ? 2 : 1
  }
  io.err(`dm1: internal_error: ${(e as Error).message}`)
  return 1
}

export async function run(io: Io): Promise<number> {
  const found: { cap?: Capability } = {}
  try {
    return await dispatch(io, found)
  } catch (e) {
    return fail(io, e, found.cap)
  }
}

async function dispatch(io: Io, found: { cap?: Capability }): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: io.argv, options: OPTIONS, allowPositionals: true })
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n  Run dm1 --help.`)
  }
  const v = parsed.values as Values
  const [name, ...rest] = parsed.positionals

  if (v.version) {
    io.out(VERSION)
    return 0
  }
  if (name === undefined) {
    io.out(HELP)
    return 0
  }

  const color = io.stdoutIsTty && v['no-color'] !== true && !io.env.NO_COLOR

  if (name === 'check') {
    if (v.help === true) {
      io.out(CHECK_HELP)
      return 0
    }
    return await check(io, client(io, v), v, color)
  }

  const cap = CAPABILITIES[name]
  if (!cap) throw new UsageError(`unknown capability ${name}. Run dm1 --help.`)
  found.cap = cap
  if (v.help === true) {
    io.out(cap.help)
    return 0
  }
  if (v.check === true && !cap.checkable)
    throw new UsageError(`--check works with yes-no and verify only, not ${name}.`)

  const min = v.min === undefined ? null : number('--min', v.min)
  const minConfidence =
    v['min-confidence'] === undefined ? null : number('--min-confidence', v['min-confidence'])
  // A gate on a field the result never carries would pass on every run.
  if (min !== null && !cap.probability)
    throw new UsageError(`--min reads a probability. A ${name} result carries none.`)
  if (minConfidence !== null && !cap.confidence)
    throw new UsageError(`--min-confidence reads a confidence. A ${name} result carries none.`)

  // stdin is read last, and only when it is the source. `dm1 <capability> --help`, `--file`
  // and `--lines` must never block on a pipe that a parent process left open.
  const explicit = io.argv.includes('-') || io.argv.includes('@-')
  const reads = explicit || (!io.stdinIsTty && v.lines === undefined && (v.file ?? []).length === 0)
  const piped = reads ? await io.stdin() : ''
  const stdin = () => piped

  const source = resolveInput({
    files: v.file ?? [],
    lines: v.lines,
    positionals: rest,
    stdin,
    stdinIsTty: io.stdinIsTty,
    hasImage: v.image !== undefined,
  })
  if (source.note !== undefined) io.err(source.note)
  const spec = parseSpec(source.items, cap.described, stdin)
  const names = Array.isArray(spec.list) ? spec.list : Object.keys(spec.list)
  // The hint names the label the user typed first, not the one the model picked.
  const bare = spec.bare ? names[0] : undefined
  const dm = client(io, v)

  const mode: Mode =
    v.raw === true
      ? 'raw'
      : v.jsonl === true
        ? 'jsonl'
        : v.quiet === true
          ? 'quiet'
          : v.json === true || !io.stdoutIsTty
            ? 'json'
            : 'table'

  // The body a user piped in wins over the SDK's own body building. Flags still override
  // single keys, so `pbpaste | dm1 classify --json` stays one command.
  const body = source.body
    ? { ...source.body, ...cap.fragment({ dm, input: source.input, list: spec.list, v, stdin }) }
    : null
  const batch = Array.isArray(source.input)
  const env: Envelope = body ? envelopeOf(cap, body) : cap.envelope

  const pieces: (string | string[])[] = batch ? chunk(source.input as string[]) : [source.input]
  const decided: Decided[] = []
  const total = { chars: 0, tokens: 0, ms: 0, rateLimit: null as RateLimit | null }
  const streaming = mode === 'jsonl' || mode === 'quiet'

  for (const [i, piece] of pieces.entries()) {
    let value: unknown
    let usage: Usage
    try {
      const got = await (
        body
          ? dm.post<unknown>(path(cap.name), body)
          : cap.call({ dm, input: piece, list: spec.list, v, stdin })
      ).withUsage()
      usage = got.usage
      value = body ? unwrapBody(got.result, env, batch) : got.result
    } catch (e) {
      // status 0 means nothing was sent. That is bad usage, not a failed chunk.
      if (pieces.length > 1 && isMillisecondsError(e) && e.status !== 0) {
        // A streaming mode already printed every earlier chunk.
        if (!streaming) emit(io, decided, mode, cap, color, batch, bare, names)
        const first = i * CHUNK + 1
        io.err(
          `dm1: ${e.code}: chunk ${i + 1} of ${pieces.length} (texts ${first}-${first + (piece as string[]).length - 1}) failed.\n${e.message}`,
        )
        // The chunks that succeeded were billed, so they still get their usage line.
        if (v.usage === true) io.err(usageLine(total))
        return 1
      }
      // Same reason on the way out of a batch: earlier chunks were billed.
      if (v.usage === true && total.chars > 0) io.err(usageLine(total))
      throw e
    }
    total.chars += usage.inputChars
    total.tokens += usage.inputTokens
    total.ms += usage.inferenceMs
    total.rateLimit = usage.rateLimit ?? total.rateLimit

    const part: Decided[] = Array.isArray(piece)
      ? piece.map((t, k) => ({
          text: t,
          result: (value as unknown[])[k],
          raw: wrapOne((value as unknown[])[k], env),
        }))
      : [{ text: piece, result: value, raw: wrapOne(value, env) }]
    // A streaming mode flushes per chunk, so a later failure still leaves usable output.
    if (streaming) emit(io, part, mode, cap, color, batch, bare, names)
    decided.push(...part)
  }

  if (!streaming) emit(io, decided, mode, cap, color, batch, bare, names)
  if (v.usage === true) io.err(usageLine(total))
  return failed(decided, v, min, minConfidence, cap) ? 3 : 0
}

/** The CLI never chunks a piped body: the user wrote it, so the SDK sends it unchanged. */
function unwrapBody(raw: unknown, env: Envelope, batch: boolean): unknown {
  if (!batch) return unwrapOne(raw, env)
  const inner = (raw as { results?: unknown[] }).results ?? []
  return inner.map((r) => unwrapOne(r, env))
}

/** A piped body picks its own shape: `statement` answers one result, `statements` a list. */
function envelopeOf(cap: Capability, body: Record<string, unknown>): Envelope {
  if (cap.name === 'yes-no') return body.statement === undefined ? 'results' : null
  if (cap.name === 'answer') return body.question === undefined ? 'results' : null
  return cap.envelope
}

function client(io: Io, v: Values): DecisionMachine {
  // The SDK names its own constructor here. A dm1 user needs the shell answer instead.
  if (!(v.key ?? io.env.MS_API_KEY))
    throw new UsageError(
      'no API key. Run export MS_API_KEY=sk-ms-..., or pass --key. Get a key at https://console.milliseconds.ai.',
    )
  return new DecisionMachine({
    apiKey: v.key ?? io.env.MS_API_KEY,
    ...(v['base-url'] === undefined ? {} : { baseUrl: v['base-url'] }),
    ...(v.retries === undefined ? {} : { maxRetries: number('--retries', v.retries) }),
    ...(v.timeout === undefined ? {} : { timeout: number('--timeout', v.timeout) }),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  })
}

/** stdout holds results only. One blank line separates the texts of a batch. */
function emit(
  io: Io,
  decided: Decided[],
  mode: Mode,
  cap: Capability,
  color: boolean,
  batch: boolean,
  bare: string | undefined,
  names: string[],
): void {
  if (decided.length === 0) return
  const dim = dimmer(color)
  // A terminal reads indented JSON. A pipe gets the compact form `jq` expects.
  const indent = io.stdoutIsTty ? 2 : 0
  if (mode === 'raw') {
    const raws = decided.map((d) => d.raw)
    io.out(JSON.stringify(batch ? { results: raws } : raws[0], null, indent))
    return
  }
  if (mode === 'json') {
    const results = decided.map((d) => d.result)
    io.out(JSON.stringify(batch ? results : results[0], null, indent))
    return
  }
  if (mode === 'jsonl') {
    for (const d of decided) io.out(JSON.stringify(line(d, cap.envelope)))
    return
  }
  if (mode === 'quiet') {
    for (const d of decided) for (const l of cap.quiet(d.result)) io.out(l)
    return
  }
  const blocks = decided.map((d) =>
    batch
      ? `${dim(head(d.text))}\n${cap.table(d.result, dim, names)}`
      : cap.table(d.result, dim, names),
  )
  io.out(blocks.join('\n\n'))
  // Bare label names cost accuracy. Say it once, and only where a human reads it.
  if (bare !== undefined && cap.name === 'classify')
    io.out(`\n  Bare label names score worse. Try: ${bare}="charges and refunds"`)
}

const head = (text: string) => (text.length > 72 ? `${text.slice(0, 71)}…` : text)

/** One compact object per line, with the input text, so a batch stays joinable. */
function line(d: Decided, env: Envelope): Record<string, unknown> {
  if (Array.isArray(d.result)) return { text: d.text, [env ?? 'results']: d.result }
  // The input text goes last: an extracted field named `text` must not take the join key.
  return { ...(d.result as Record<string, unknown>), text: d.text }
}

function usageLine(t: {
  chars: number
  tokens: number
  ms: number
  rateLimit: RateLimit | null
}): string {
  const rate = t.rateLimit
    ? `, ${int(t.rateLimit.remainingRequests)}/${int(t.rateLimit.limitRequests)} requests left`
    : ''
  return `usage: ${int(t.chars)} chars, ${int(t.tokens)} tokens, ${int(t.ms)} ms inference${rate}`
}

/** `--check`, `--min` and `--min-confidence`. The result still printed, so this only exits 3. */
function failed(
  decided: Decided[],
  v: Values,
  min: number | null,
  minConfidence: number | null,
  cap: Capability,
): boolean {
  if (v.check !== true && min === null && minConfidence === null) return false
  for (const d of decided) {
    const list = items(d.result)
    // A gate that verified nothing has not passed.
    if (v.check === true && list.length === 0) return true
    for (const item of list) {
      if (v.check === true) {
        const yes = cap.name === 'verify' ? item.matches === true : item.answer === true
        if (!yes) return true
      }
      if (min !== null && typeof item.probability === 'number' && item.probability < min)
        return true
      if (
        minConfidence !== null &&
        typeof item.confidence === 'number' &&
        item.confidence < minConfidence
      )
        return true
    }
  }
  return false
}

/** One small classify. It proves the key, the endpoint and the limits. */
async function check(io: Io, dm: DecisionMachine, v: Values, color: boolean): Promise<number> {
  const started = Date.now()
  const { usage } = await dm.classify('ok', ['yes', 'no']).withUsage()
  const round = Date.now() - started
  const key = v.key ?? io.env.MS_API_KEY ?? ''
  const masked = key.length > 16 ? `${key.slice(0, 12)}…${key.slice(-4)}` : key
  const rl = usage.rateLimit

  if (v.json === true || !io.stdoutIsTty) {
    io.out(
      JSON.stringify(
        {
          key: masked,
          endpoint: dm.baseUrl,
          round_trip_ms: round,
          inference_ms: usage.inferenceMs,
          rate_limit: rl,
        },
        null,
        io.stdoutIsTty ? 2 : 0,
      ),
    )
    return 0
  }

  const limits = rl ? `${int(rl.limitRequests)} req/min` : 'unknown'
  const remaining = rl ? `${int(rl.remainingRequests)} req` : 'unknown'
  const width = Math.max(limits.length, remaining.length)
  const dim = dimmer(color)
  io.out(
    kv(
      [
        ['key', `${masked}   valid`],
        ['endpoint', dm.baseUrl],
        ['latency', `${int(round)} ms round trip · ${int(usage.inferenceMs)} ms model`],
        ['limits', rl ? `${limits.padEnd(width)}  ·  ${int(rl.limitTokens)} tok/min` : 'unknown'],
        [
          'remaining',
          rl ? `${remaining.padEnd(width)}  ·  ${int(rl.remainingTokens)} tok` : 'unknown',
        ],
      ],
      dim,
      10,
    ),
  )
  io.out('ok')
  return 0
}
