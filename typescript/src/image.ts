import { clientError } from './errors'

import type { ImageInput } from './types'

/** 5 MB decoded. The API rejects more, so the SDK rejects it before the round trip. */
const MAX_BYTES = 5 * 1024 * 1024
/** The base64 length of MAX_BYTES. Checked before any decode, as the API does. */
const MAX_BASE64 = Math.ceil((MAX_BYTES * 4) / 3)

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,/
/** The base64 of the first bytes of a JPEG, a PNG and a WebP. */
const MAGIC = ['/9j/', 'iVBORw0', 'UklGR']

const TOO_LARGE = `The image is over the 5 MB limit. Resize it, or send a smaller crop.`
const NOT_IMAGE =
  'The image must be a data:image/(jpeg|png|webp);base64,... URL, or the bare base64 of a JPEG, PNG or WebP.'
const NO_URL =
  'The API never fetches a URL. Read the bytes yourself and send them: imageFile(path) from @cloudraker/milliseconds/node.'

/**
 * One image, as the wire wants it: a data URL or bare base64.
 *
 * A Blob holds its bytes behind a promise, so that one case answers a promise. Every
 * other input answers a string, and a bad image throws before the call is built.
 */
export function encodeImage(image: ImageInput): string | Promise<string> {
  if (typeof image === 'string') return checkEncoded(image)
  if (image instanceof ArrayBuffer) return fromBytes(new Uint8Array(image))
  if (ArrayBuffer.isView(image))
    return fromBytes(new Uint8Array(image.buffer, image.byteOffset, image.byteLength))
  return image.arrayBuffer().then((bytes) => fromBytes(new Uint8Array(bytes)))
}

function checkEncoded(image: string): string {
  if (/^https?:/i.test(image)) throw clientError(NO_URL)
  const base64 = image.startsWith('data:') ? dataUrlBody(image) : image
  if (base64.length > MAX_BASE64) throw clientError(TOO_LARGE)
  if (!MAGIC.some((m) => base64.startsWith(m))) throw clientError(NOT_IMAGE)
  return image
}

function dataUrlBody(image: string): string {
  const match = DATA_URL.exec(image)
  if (!match) throw clientError(NOT_IMAGE)
  return image.slice(match[0].length)
}

function fromBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_BYTES) throw clientError(TOO_LARGE)
  // `btoa` takes a binary string. 32k at a time keeps the argument list inside the
  // engine's limit; String.fromCharCode(...bytes) on 5 MB overflows the stack.
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return checkEncoded(btoa(binary))
}
