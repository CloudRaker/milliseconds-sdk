import { Client } from './client'
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

/** The batch shape follows the request, never the response. */
const same = (raw: unknown) => raw
const key = (name: 'results' | 'data' | 'entities') => (raw: unknown) =>
  (raw as Record<string, unknown>)[name]

/** `text` for one result, `texts` for a batch. The mutual exclusion is impossible here. */
const inputBody = (input: Input) => (typeof input === 'string' ? { text: input } : { texts: input })

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
    options?: CallOptions & { when_true?: string; when_false?: string },
  ): Decision<
    Fan<
      T,
      S extends readonly string[]
        ? { -readonly [K in keyof S]: YesNoResult<S[K] & string> }
        : YesNoResult<S & string>
    >
  > {
    checkInput(input)
    checkSpec('statements', statements)
    const { when_true, when_false, ...call } = options ?? {}
    const body = {
      ...inputBody(input),
      ...(typeof statements === 'string' ? { statement: statements } : { statements }),
      ...(when_true === undefined ? {} : { when_true }),
      ...(when_false === undefined ? {} : { when_false }),
    }
    return this.capability(
      'yes-no',
      body,
      input,
      call,
      typeof statements === 'string' ? same : key('results'),
    )
  }

  /** Picks one label and returns the full distribution. Describe each label. */
  classify<const T extends Input, const L extends Labels>(
    input: T,
    labels: L,
    options?: CallOptions,
  ): Decision<Fan<T, ClassifyResult<LabelOf<L>>>> {
    checkInput(input)
    checkList('labels', labels, 2, 64, 'classify')
    return this.capability('classify', { ...inputBody(input), labels }, input, options, same)
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
    options?: CallOptions,
  ): Decision<Fan<T, ClassifyTreeResult<TreeLabels<N>, LeafLabels<N>>>> {
    checkInput(input)
    checkList('labels', tree, 2, 64, 'classify-tree', true)
    return this.capability('classify-tree', { ...inputBody(input), tree }, input, options, same)
  }

  /** Places the text on an ordered scale of described levels, low to high. */
  rate<const T extends Input, const S extends readonly string[]>(
    input: T,
    scale: S,
    options?: CallOptions,
  ): Decision<Fan<T, RateResult<S>>> {
    checkInput(input)
    checkList('scale', scale, 2, 10, 'rate')
    return this.capability('rate', { ...inputBody(input), scale }, input, options, same)
  }

  /** Quotes the answer out of the text, with its offsets. `answer` is null when nothing fits. */
  answer<const T extends Input, const Q extends string | readonly string[]>(
    input: T,
    questions: Q,
    options?: CallOptions,
  ): Decision<
    Fan<
      T,
      Q extends readonly string[]
        ? { -readonly [K in keyof Q]: AnswerResult<Q[K] & string> }
        : AnswerResult<Q & string>
    >
  > {
    checkInput(input)
    checkSpec('questions', questions)
    const body = {
      ...inputBody(input),
      ...(typeof questions === 'string' ? { question: questions } : { questions }),
    }
    return this.capability(
      'answer',
      body,
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
    options?: CallOptions,
  ): Decision<Fan<T, Extracted<SchemaOutput<S>>>> {
    checkInput(input)
    const json = toJsonSchema(schema)
    checkSchema(json)
    return this.capability(
      'extract',
      { ...inputBody(input), schema: json },
      input,
      options,
      key('data'),
    )
  }

  /** Finds every span matching each type, with offsets, sorted by start. */
  entities<const T extends Input, const E extends Labels>(
    input: T,
    types: E,
    options?: CallOptions,
  ): Decision<Fan<T, Entity<LabelOf<E>>[]>> {
    checkInput(input)
    checkList('types', types, 1, 64, 'entities')
    return this.capability(
      'entities',
      { ...inputBody(input), types },
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
    options?: CallOptions,
  ): Decision<Fan<T, VerifyResult>> {
    checkInput(input)
    const body = {
      ...inputBody(input),
      field: typeof field === 'string' ? { name: field } : field,
      value,
    }
    return this.capability('verify', body, input, options, same)
  }

  /** `{ results }` is unwrapped for a batch, and the per-text envelope for one text. */
  private capability<R>(
    name: string,
    body: object,
    input: Input,
    options: CallOptions | undefined,
    one: (raw: unknown) => unknown,
  ): Decision<R> {
    const unwrap =
      typeof input === 'string'
        ? one
        : (raw: unknown) => ((raw as { results: unknown[] }).results ?? []).map(one)
    return this.call<R>(`/v1/${MODEL}/${name}`, body, options, unwrap as (raw: unknown) => R)
  }
}
