import type { ErrorCode, RateLimit } from './types'

/** A brand property, so a duplicated copy of the package in a bundle still matches. */
const BRAND = '~milliseconds.error'

export interface ErrorInit {
  code: ErrorCode
  /** 0 when the call never reached the API. */
  status?: number
  /** The API's own message, unchanged. */
  apiMessage: string
  /** The thrown `message`: the API message plus one hint line. */
  message?: string
  retryAfter?: number | null
  rateLimit?: RateLimit | null
  response?: Response | null
  attempts?: number
  retryable?: boolean
  cause?: unknown
}

/**
 * One error class. Switch on `code`: the union narrows exhaustively and never goes stale
 * when the API adds a code.
 */
export class MillisecondsError extends Error {
  readonly name = 'MillisecondsError'
  readonly [BRAND] = true
  readonly code: ErrorCode
  /** 0 when the call never reached the API. */
  readonly status: number
  /** The API's own message, unchanged. `message` adds one hint line. */
  readonly apiMessage: string
  /** Seconds from the retry-after header. Only 429 rate_limit_exceeded carries it. */
  readonly retryAfter: number | null
  readonly rateLimit: RateLimit | null
  readonly response: Response | null
  /** Attempts this call made, including the first. */
  readonly attempts: number
  /** True for the codes the SDK retries. */
  readonly retryable: boolean

  constructor(init: ErrorInit) {
    super(
      init.message ?? init.apiMessage,
      init.cause === undefined ? undefined : { cause: init.cause },
    )
    this.code = init.code
    this.status = init.status ?? 0
    this.apiMessage = init.apiMessage
    this.retryAfter = init.retryAfter ?? null
    this.rateLimit = init.rateLimit ?? null
    this.response = init.response ?? null
    this.attempts = init.attempts ?? 1
    this.retryable = init.retryable ?? false
  }
}

export function isMillisecondsError(e: unknown): e is MillisecondsError {
  return typeof e === 'object' && e !== null && (e as Record<string, unknown>)[BRAND] === true
}

/** Every client-side check throws this: status 0, code client_error, nothing sent. */
export const clientError = (message: string): MillisecondsError =>
  new MillisecondsError({ code: 'client_error', status: 0, apiMessage: message })
