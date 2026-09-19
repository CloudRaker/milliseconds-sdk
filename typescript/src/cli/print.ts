/** A result object. The CLI reads results by name, so one alias beats a cast per field. */
export type Row = Record<string, unknown>

export const num = (r: Row, k: string): number => Number(r[k] ?? 0)
export const text = (r: Row, k: string): string => String(r[k] ?? '')
export const p3 = (n: number): string => n.toFixed(3)
export const int = (n: number): string => n.toLocaleString('en-US')

/** ANSI off for --no-color, for NO_COLOR, and for a pipe. */
export const dimmer = (color: boolean) => (s: string) => (color ? `\u001B[2m${s}\u001B[0m` : s)

/** `label        billing` — a padded key column. */
export const kv = (rows: [string, string][], dim: (s: string) => string, width = 12): string =>
  rows.map(([k, v]) => `${dim(k.padEnd(width))} ${v}`).join('\n')

/** 20 blocks at 1.0. 0.001 rounds to none, so a flat score prints no bar. */
const bar = (p: number) => '█'.repeat(Math.round(p * 20))

/** The scores block under a table. `sort` orders by score; a scale keeps its own order. */
export function scores(
  entries: [string, number][],
  dim: (s: string) => string,
  sort: boolean,
): string {
  // oxlint-disable-next-line unicorn/no-array-sort -- the spread above is already a copy
  const rows = sort ? [...entries].sort((a, b) => b[1] - a[1]) : entries
  const width = Math.max(0, ...rows.map(([name]) => name.length)) + 3
  const body = rows.map(([name, p]) => {
    const drawn = bar(p)
    return `  ${name.padEnd(width)}${p3(p)}${drawn ? `  ${drawn}` : ''}`
  })
  return [dim('scores'), ...body].join('\n')
}

/** An aligned block of columns, two spaces apart. */
export function columns(rows: string[][]): string {
  const width: number[] = []
  for (const row of rows)
    row.forEach((cell, i) => (width[i] = Math.max(width[i] ?? 0, cell.length)))
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(width[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}
