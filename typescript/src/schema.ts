import { MillisecondsError } from './errors'

import type { ExtractSchema, JsonSchema, Typed } from './types'

/**
 * Brands a JSON Schema with the type it produces. One cast, no runtime cost.
 *
 * `dm.extract(text, typed<z.infer<typeof S>>(z.toJSONSchema(S)))`
 */
export const typed = <T>(schema: JsonSchema): Typed<T> => schema as Typed<T>

const CONVERT =
  'Pass a JSON Schema. zod: typed<z.infer<typeof S>>(z.toJSONSchema(S)). valibot: typed<v.InferOutput<typeof S>>(toJsonSchema(S)). arktype works directly.'

type Convertible = {
  toJsonSchema?: () => JsonSchema
  toJSONSchema?: () => JsonSchema
  '~standard'?: unknown
}

/**
 * The object to send. A Standard Schema with a converter method (arktype) is converted.
 * A Standard Schema without one cannot be: the SDK has zero dependencies, so it names the
 * one line that converts it instead of importing zod.
 */
export function toJsonSchema(schema: ExtractSchema): JsonSchema {
  const s = schema as Convertible
  const convert = typeof s.toJsonSchema === 'function' ? s.toJsonSchema : s.toJSONSchema
  if (typeof convert === 'function') return convert.call(s)
  if ('~standard' in s)
    throw new MillisecondsError({ code: 'invalid_schema', status: 0, apiMessage: CONVERT })
  return s as JsonSchema
}
