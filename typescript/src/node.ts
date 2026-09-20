// Node only. The library entry point must never import this file: it pulls a node:
// specifier in, and a browser or Worker bundle then breaks.
import { readFileSync } from 'node:fs'

/** The data URL of an image file, ready as the input or as `options.image`. */
export const imageFile = (path: string): string => {
  const bytes = readFileSync(path)
  const type = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    ? 'jpeg'
    : bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      ? 'png'
      : bytes.subarray(0, 4).toString('latin1') === 'RIFF'
        ? 'webp'
        : null
  if (!type) throw new Error(`${path} is not a JPEG, PNG or WebP.`)
  return `data:image/${type};base64,${bytes.toString('base64')}`
}
