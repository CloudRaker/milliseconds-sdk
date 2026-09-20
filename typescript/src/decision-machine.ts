import { Client } from './client'
import { clientError } from './errors'
import { encodeImage } from './image'
import { toJsonSchema } from './schema'
import { checkInput, checkList, checkSchema, checkSpec } from './validate'

import type {
  AnswerResult,
  CallOptions,
  ClassifyResult,
  ClassifyTreeResult,
  Decision,
  Entity,
  ExtractSchema,
  Extracted,
  Fan,
  ImageInput,
  ImageOptions,
  Input,
  LabelOf,
  Labels,
  LeafLabels,
  RateResult,
  SchemaOutput,
  Tree,
  TreeLabels,
  VerifyResult,
  YesNoResult,
} from './types'

const MODEL = 'decision-machine-1'

/** An image answer has no text to index, so its offsets are null. */
type Offsets<O> = O extends { image: ImageInput } ? null : number

/** The batch shape follows the request, never the response. */
const same = (raw: unknown) => raw
const key = (name: 'results' | 'entities') => (raw: unknown) =>
  (raw as Record<string, unknown>)[name]

/** `{ data }` is unwrapped. */
const extracted = (raw: unknown) => (raw as { data: object }).data

/**
 * `text` for one result, `texts` for a batch. The mutual exclusion is impossible here.
 *
 * An empty string sends no text at all. Only an image call reaches this: `checkInput`
 * refuses an empty text otherwise.
 */
const inputBody = (input: Text) =>
  typeof input === 'string' ? (input === '' ? {} : { text: input }) : { texts: input }

type Text = string | readonly string[]
const PICTURE_STRING = /^data:image\//i

/**
 * The image may be the input itself: `dm.classify(imageFile('receipt.jpg'), LABELS)`. It then
 * moves to `options.image` and the text becomes empty, so every other line reads one shape.
 */
function pictured<O extends ImageOptions | undefined>(input: Input, options: O): [Text, O] {
  const picture = typeof input === 'string' ? PICTURE_STRING.test(input) : !Array.isArray(input)
  if (!picture) return [input as Text, options]
  if (options?.image !== undefined)
    throw clientError('One image per call: pass it as the input, or as options.image, not both.')
  return ['', { ...options, image: input as ImageInput } as O]
}

/** The body, plus the image when there is one. A Blob makes it a promise. */
function withImage(body: object, options: ImageOptions | undefined): object | Promise<object> {
  if (options?.image === undefined) return body
  const detail = options.detail === undefined ? {} : { detail: options.detail }
  const encoded = encodeImage(options.image)
  return typeof encoded === 'string'
    ? { ...body, ...detail, image: encoded }
    : encoded.then((image) => ({ ...body, ...detail, image }))
}

/**
 * `decision-machine-1` at api.milliseconds.ai. Every capability is a pure function, so
 * every retry is safe.
 */
export class DecisionMachine extends Client {
  /** Paths are `${baseUrl}/v1/${model}/<capability>`. */
  static readonly model = MODEL

  /**
   * Answers each statement with yes or no and a probability. The statements share one
   * inference call, so extra statements are nearly free.
   */
  yesNo<const T extends Input, const S extends string | readonly string[]>(
    input: T,
    statements: S,
    options?: CallOptions & ImageOptions & { when_true?: string; when_false?: string },
  ): Decision<
    Fan<
      T,
      S extends readonly string[]
        ? { -readonly [K in keyof S]: YesNoResult<S[K] & string> }
        : YesNoResult<S & string>
    >
  > {
    const [text, opts] = pictured(input, options)
    checkInput(text, opts?.image !== undefined)
    checkSpec('statements', statements)
    const { when_true, when_false, ...call } = options ?? {}
    const body = {
      ...inputBody(text),
      ...(typeof statements === 'string' ? { statement: statements } : { statements }),
      ...(when_true === undefined ? {} : { when_true }),
      ...(when_false === undefined ? {} : { when_false }),
    }
    return this.capability(
      'yes-no',
      withImage(body, opts),
      input,
      call,
      typeof statements === 'string' ? same : key('results'),
    )
  }

  /** Picks one label and returns the full distribution. Describe each label. */
  classify<const T extends Input, const L extends Labels>(
    input: T,
    labels: L,
    options?: CallOptions & ImageOptions,
  ): Decision<Fan<T, ClassifyResult<LabelOf<L>>>> {
    const [text, opts] = pictured(input, options)
    checkInput(text, opts?.image !== undefined)
    checkList('labels', labels, 2, 64, 'classify')
    return this.capability(
      'classify',
      withImage({ ...inputBody(text), labels }, opts),
      input,
      options,
      same,
    )
  }

  /**
   * Runs classify once per level of a nested tree, descending into the winner.
   *
   * The per-level `input_chars` and `input_tokens` do not sum to `Usage.inputChars`: the
   * header counts one pass over the body, and each level re-sends the text.
   */
  classifyTree<const T extends Input, const N extends Tree>(
    input: T,
    tree: N,
    options?: CallOptions & ImageOptions,
  ): Decision<Fan<T, ClassifyTreeResult<TreeLabels<N>, LeafLabels<N>>>> {
    const [text, opts] = pictured(input, options)
    checkInput(text, opts?.image !== undefined)
    checkList('labels', tree, 2, 64, 'classify-tree', true)
    return this.capability(
      'classify-tree',
      withImage({ ...inputBody(text), tree }, opts),
      input,
      options,
      same,
    )
  }

  /** Places the text on an ordered scale of described levels, low to high. */
  rate<const T extends Input, const S extends readonly string[]>(
    input: T,
    scale: S,
    options?: CallOptions & ImageOptions,
  ): Decision<Fan<T, RateResult<S>>> {
    const [text, opts] = pictured(input, options)
    checkInput(text, opts?.image !== undefined)
    checkList('scale', scale, 2, 10, 'rate')
    return this.capability(
      'rate',
      withImage({ ...inputBody(text), scale }, opts),
      input,
      options,
      same,
    )
  }

  /** Quotes the answer out of the text, with its offsets. `answer` is null when nothing fits. */
  answer<
    const T extends Input,
    const Q extends string | readonly string[],
    const O extends CallOptions & ImageOptions = CallOptions,
  >(
    input: T,
    questions: Q,
    options?: O,
  ): Decision<
    Fan<
      T,
      Q extends readonly string[]
        ? { -readonly [K in keyof Q]: AnswerResult<Q[K] & string, Offsets<O>> }
        : AnswerResult<Q & string, Offsets<O>>
    >
  > {
    const [text, opts] = pictured(input, options)
    checkInput(text, opts?.image !== undefined)
    checkSpec('questions', questions)
    const body = {
      ...inputBody(text),
      ...(typeof questions === 'string' ? { question: questions } : { questions }),
    }
    return this.capability(
      'answer',
      withImage(body, opts),
      input,
      options,
      typeof questions === 'string' ? same : key('results'),
    )
  }

  /**
   * Fills a JSON Schema from the text. Missing values are null, arrays of objects come back
   * empty, arrays of scalars come back as strings, and enums are not checked server side.
   */
  extract<const T extends Input, const S extends ExtractSchema>(
    input: T,
    schema: S,
    options?: CallOptions & ImageOptions,
  ): Decision<Fan<T, Extracted<SchemaOutput<S>>>> {
    const [text, opts] = pictured(input, options)
    checkInput(text, opts?.image !== undefined)
    const json = toJsonSchema(schema)
    checkSchema(json)
    return this.capability(
      'extract',
      withImage({ ...inputBody(text), schema: json }, opts),
      input,
      options,
      extracted,
    )
  }

  /** Finds every span matching each type, with offsets, sorted by start. */
  entities<const T extends Input, const E extends Labels>(
    input: T,
    types: E,
    options?: CallOptions & ImageOptions,
  ): Decision<Fan<T, Entity<LabelOf<E>>[]>> {
    const [text, opts] = pictured(input, options)
    checkInput(text, opts?.image !== undefined)
    checkList('types', types, 1, 64, 'entities')
    return this.capability(
      'entities',
      withImage({ ...inputBody(text), types }, opts),
      input,
      options,
      key('entities'),
    )
  }

  /** Checks whether the text says `value` for `field`. */
  verify<const T extends Input>(
    input: T,
    field: string | { name: string; description?: string },
    value: string | number,
    options?: CallOptions & ImageOptions,
  ): Decision<Fan<T, VerifyResult>> {
    const [text, opts] = pictured(input, options)
    checkInput(text, opts?.image !== undefined)
    const body = {
      ...inputBody(text),
      field: typeof field === 'string' ? { name: field } : field,
      value,
    }
    return this.capability('verify', withImage(body, opts), input, options, same)
  }

  /** `{ results }` is unwrapped for a batch, and the per-text envelope for one text. */
  private capability<R>(
    name: string,
    body: object | Promise<object>,
    input: Input,
    options: CallOptions | undefined,
    one: (raw: unknown) => unknown,
  ): Decision<R> {
    const unwrap = Array.isArray(input)
      ? (raw: unknown) => ((raw as { results: unknown[] }).results ?? []).map(one)
      : one
    return this.call<R>(`/v1/${MODEL}/${name}`, body, options, unwrap as (raw: unknown) => R)
  }
}
