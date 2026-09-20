import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    // The library. `platform: 'neutral'` keeps Node, Bun, Deno, browsers and Workers in.
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'neutral',
    dts: true,
    clean: true,
  },
  {
    // The Node-only helpers, on their own subpath. `imageFile` reads a file, so this
    // entry may hold a node: specifier and the library entry may not.
    entry: { node: 'src/node.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    dts: true,
    clean: false,
  },
  {
    // The CLI. It must never be reachable from the library entry point, or a bundler
    // pulls node: specifiers into a browser build.
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    platform: 'node',
    dts: false,
    clean: false,
    // `bin` points at dist/cli.js, so pin the name and the extension.
    outputOptions: { entryFileNames: 'cli.js', banner: '#!/usr/bin/env node' },
  },
])
