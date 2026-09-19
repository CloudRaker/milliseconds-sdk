import { readFileSync } from 'node:fs'

/** Bad arguments or bad stdin. Nothing was sent, so `dm1` exits 2. */
export class UsageError extends Error {}

/** A label, type, statement, question or level list. */
export type SpecList = string[] | Record<string, string>

export const specSize = (list: SpecList): number =>
  Array.isArray(list) ? list.length : Object.keys(list).length

/** Reads a file, or stdin for `-`. */
function read(path: string, stdin: () => string): string {
  if (path === '-') return stdin()
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${(e as Error).message}`)
  }
}

/** `@labels.json` and `--schema @invoice.json`. `@-` reads stdin. */
export function loadJson(path: string, stdin: () => string): unknown {
  const raw = read(path, stdin)
  try {
    return JSON.parse(raw) as unknown
  } catch (e) {
    throw new UsageError(`${path === '-' ? 'stdin' : path} is not JSON: ${(e as Error).message}`)
  }
}

/** `--schema` and `--tree` take a file, `@file`, `@-` or inline JSON. */
export function loadDocument(flag: string, value: string, stdin: () => string): unknown {
  if (value.trimStart().startsWith('{')) {
    try {
      return JSON.parse(value) as unknown
    } catch (e) {
      throw new UsageError(`--${flag} is not JSON: ${(e as Error).message}`)
    }
  }
  return loadJson(value.replace(/^@/, ''), stdin)
}

/**
 * Turns the positionals into the capability's list.
 *
 * `described` splits `name=description` on the first `=`. yes-no, answer and rate take free
 * text, so they never split. `@path` loads a JSON array or a name-to-description object.
 */
export function parseSpec(
  items: string[],
  described: boolean,
  stdin: () => string,
): { list: SpecList; bare: boolean } {
  const names: string[] = []
  const map: Record<string, string> = {}
  let mapped = false
  for (const item of items) {
    if (item.startsWith('@')) {
      const loaded = loadJson(item.slice(1), stdin)
      if (Array.isArray(loaded)) {
        names.push(...(loaded as string[]).map(String))
      } else if (typeof loaded === 'object' && loaded !== null) {
        // The three free-text capabilities send the names only, so a map would drop every
        // description. The scale is the instruction, so that is a wrong answer, not a warning.
        if (!described)
          throw new UsageError(
            `${item.slice(1)} holds a name-to-description object. yes-no, rate and answer take a JSON array.`,
          )
        mapped = true
        for (const [k, v] of Object.entries(loaded)) map[k] = String(v)
      } else {
        throw new UsageError(`${item.slice(1)} must hold an array or a name-to-description object.`)
      }
      continue
    }
    const at = described ? item.indexOf('=') : -1
    if (at > 0) {
      mapped = true
      map[item.slice(0, at)] = item.slice(at + 1)
    } else {
      names.push(item)
    }
  }
  if (!mapped) return { list: names, bare: true }
  // A bare name beside described ones keeps its place with an empty description.
  for (const name of names) map[name] ??= ''
  return { list: map, bare: false }
}
