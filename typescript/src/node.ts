// Node only. The library entry point must never import this file: it pulls a node:
// specifier in, and a browser or Worker bundle then breaks.
import { readFileSync } from 'node:fs'

/**
 * The base64 of an image file, ready for `image`.
 *
 * `dm.classify(imageFile('receipt.jpg'), LABELS)` is wrong: pass it as the option.
 * `dm.classify('', LABELS, { image: imageFile('receipt.jpg') })`
 */
export const imageFile = (path: string): string => readFileSync(path).toString('base64')
