# milliseconds-sdk

The official SDKs for `decision-machine-1` at [milliseconds.ai](https://milliseconds.ai).

`decision-machine-1` decides. It does not generate. Send text, or one image, and get one
typed answer back:
a label, a yes or no, a rating, an answer span, entities, a filled JSON Schema, or a value
check. Every call is one round trip and bills input tokens only. Every capability also takes
`image` (JPEG, PNG or WebP, at most 5 MB) and `detail`.

Both SDKs are hand written. Your label names, your scale levels and your schema flow into the
result type, so a misspelled label is a compile error.

| Package                                | Install                          | Read                                       |
| -------------------------------------- | -------------------------------- | ------------------------------------------ |
| TypeScript, `@cloudraker/milliseconds`  | `npm i @cloudraker/milliseconds`    | [typescript/README.md](typescript/README.md) |
| Python, `cloudraker-milliseconds`       | `pip install cloudraker-milliseconds` | [python/README.md](python/README.md)      |
| CLI, `dm1`                              | `npm i -g @cloudraker/milliseconds` | `dm1 --help`                               |

Set your key first: `export MS_API_KEY=sk-ms-...`. Get one at
[console.milliseconds.ai](https://console.milliseconds.ai). The API reference lives at
[docs.milliseconds.ai](https://docs.milliseconds.ai), and the design contract lives in
[DESIGN.md](DESIGN.md).
