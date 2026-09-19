// dm1. It builds to dist/cli.js with a node shebang.
// The library entry point must never import this file: it pulls node: specifiers in.
import process from 'node:process'

import { run } from './run'

/** All of stdin. A pipe ends it; a terminal ends it on Ctrl-D. */
async function stdin(): Promise<string> {
  const parts: Buffer[] = []
  for await (const part of process.stdin) parts.push(part as Buffer)
  return Buffer.concat(parts).toString('utf8')
}

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  stdin,
  stdinIsTty: process.stdin.isTTY === true,
  stdoutIsTty: process.stdout.isTTY === true,
})
