# Node harness for the native parser

A [Node-API](https://nodejs.org/api/n-api.html) addon that exposes
`selectable_markdown::parseToFlatBuffer` (`platform/cpp/Protocol.h`) to plain
Node. Nothing under `src/` imports it, but it ships in the tarball
(`package.json`'s `files` lists `native/node` and
`scripts/build-node-addon.mjs`) behind the `./node` entry, so a consumer's
own tests can build the engine too. It exists so the native engine can be
tested and benchmarked without a device, and it is the only way markdown
gets parsed in Node at all, since the package has no JavaScript parser.

It stops where the real bindings stop. iOS, Android and this addon all call
`parseToFlatBuffer(source, byteLength, config)` and hand the bytes to JS
untouched; only the transport differs. So a green run here is evidence about
the parser, offset arithmetic and encoder that ship.

## Building

```sh
node scripts/build-node-addon.mjs                 # incremental
node scripts/build-node-addon.mjs --force         # ignore the object cache
node scripts/build-node-addon.mjs --clean         # delete build/
node scripts/build-node-addon.mjs --if-available  # exit 0 when unbuildable here
```

You need a C/C++ compiler (`$CC`/`$CXX`, else `clang`, `gcc` or `cc` on PATH)
and the Node C headers. The script looks next to `process.execPath`, then in
the node-gyp cache (`~/.cache/node-gyp/<version>/include/node`), then under the
configured prefix; `npm_config_nodedir` overrides all three. If none exist the
error lists the paths tried and the fix: `npx node-gyp install`.

The build is five translation units driven by `spawnSync`; there is no
node-gyp dependency. Output lands in `build/` (gitignored), keyed per platform
and arch so an arm64 Node and a Rosetta Node coexist.

`--if-available` turns a missing compiler into a message and exit 0. Real
failures (compile, link, undefined symbol) still exit non-zero. Jest's
`describeNative` uses it, so without a compiler the native suites report as
skipped. CI does not pass it: a runner that skips this build skips every
markdown-parsing check — 607 of the 1790 Jest tests, spread over 34 of the 57
suites and taking 14 of them out entirely, plus the whole conformance run — so
there a missing compiler is a failed job. (Measured 2026-10-09 against a tree
with no addon; nothing asserts those counts, so a new test file moves them.)

### The undefined-symbol guard

After linking, the script runs `nm` and fails if any undefined symbol is not
Node-API (`napi_*`, `node_api_*`) or the C/C++ runtime. Do not remove it. md4c's
`entity.h` has no `extern "C"` guard, so a C++ call site once referenced a
mangled `entity_lookup` that `entity.c` never defined. macOS addons link with
`-undefined dynamic_lookup` (required for `napi_*`), so the link and `require()`
succeeded and the process crashed on the first entity. A new libc name goes in
`KNOWN_C_RUNTIME`, or in a pinch `SELECTABLE_MARKDOWN_ALLOW_UNDEFINED=a,b`.

## Using it

```js
import { parse, protocolVersion } from './native/node/index.mjs';

const buffer = parse('# hello *world*', 0, 1);
const header = new Uint32Array(buffer, 0, 12);
// header[0] === 0x31444d53 ("SMD1"), header[1] === protocolVersion
```

`index.mjs` builds the addon on first import if it is missing. It does not
rebuild on source changes; re-run the build script after editing C++.
`parse(source, extensionBits, htmlPolicy)` mirrors the platform bindings.
`extensionBits` is an OR of the `kExt*` constants, defined in `Protocol.h`
and mirrored in `src/engine/native/protocol.ts`. `htmlPolicy` is a reserved
wire slot that `configFromBits` reads and discards. md4c is always asked to
parse HTML, so `0` (`kHtmlStrip`) and `1` (`kHtmlRaw`) return byte-identical
buffers; pass `1`, which is what the package sends. Whether HTML is stripped
or kept is decided later, by `EngineOptions.html` in the decoder. Wrong
argument types throw a `TypeError`; the `htmlPolicy` value itself is not
validated.
