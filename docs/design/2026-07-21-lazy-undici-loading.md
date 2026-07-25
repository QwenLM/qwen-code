# Lazy undici loading (lazy startup phase 3)

- Status: implemented
- Issue: QwenLM/qwen-code#7264 (candidate 4), follow-up to #4748
- Predecessors: `2026-07-19-lazy-telemetry-sdk-loading.md`,
  `2026-07-19-telemetry-protocol-split.md`

## Problem

After the telemetry phases, undici is the single largest remaining
third-party contributor to the ACP eager startup closure: 2057 KiB across
two bundled copies (cli resolves its own `undici`, core resolves another).
Every static `import { … } from 'undici'` anywhere in the closure pulls a
full copy into cold start parse/compile, even though undici is only needed
when a request actually goes out — proxy dispatchers, preconnect, IDE
client fetch options, GitHub setup, self-update.

The metafile showed eight value-import sites (type-only imports are free):

| Package | Site                           | Uses                                       |
| ------- | ------------------------------ | ------------------------------------------ |
| core    | `utils/runtimeFetchOptions.ts` | `Agent`, `ProxyAgent`, `EnvHttpProxyAgent` |
| core    | `config/config.ts`             | `EnvHttpProxyAgent`, `setGlobalDispatcher` |
| core    | `ide/ide-client.ts`            | `Agent` (IDE HTTP keep-alive)              |
| cli     | `utils/apiPreconnect.ts`       | `fetch`                                    |
| cli     | `commands/channel/proxy.ts`    | `EnvHttpProxyAgent`, `setGlobalDispatcher` |
| cli     | `utils/gitUtils.ts`            | `ProxyAgent`                               |
| cli     | `services/setup-github.ts`     | `ProxyAgent`                               |
| cli     | `utils/standalone-update.ts`   | `fetch`                                    |

## Design

All eight sites move to dynamic `import('undici')`, funneled through two
package-local single-flight helpers:

- `packages/core/src/utils/runtimeFetchOptions.ts` — `loadUndici()`, plus
  the existing `preloadRuntimeFetchModule()` now delegates to it. Sync
  consumers (`getOrCreateSharedDispatcher`, `buildFetchOptionsWithDispatcher`)
  keep their fail-loud `requireUndici()`; async entry points that can await
  (`createContentGenerator`, `Config.initialize`, IDE client connect) preload
  before any sync construction runs.
- `packages/cli/src/utils/load-undici.ts` — same helper, duplicated on
  purpose (see "Why two helpers").

Call-site notes:

- `Config`: the global proxy dispatcher installs asynchronously; the promise
  is stored and awaited at the top of `initialize()`, so the dispatcher is in
  place before any network activity, matching the previous synchronous
  ordering guarantee.
- `createContentGenerator` awaits `preloadRuntimeFetchModule()` before
  provider constructors synchronously build undici-backed fetch options.

## esbuild CJS interop (the hard part)

esbuild compiles the CJS undici package into a **default-only** dynamic
chunk: `export default require_undici()`, no named exports. So
`const { Agent } = await import('undici')` works in Node and vitest (which
synthesize named exports for CJS) but destructures `undefined` in the
bundle. Local test runs cannot catch this — only a bundled smoke run does.

`loadUndici()` therefore normalizes: if `Object.keys(mod)` is exactly
`['default']`, unwrap `mod.default`; otherwise return the namespace as-is.
The single-key check (rather than `mod.default ?? mod` or `'default' in mod`)
is deliberate:

- vitest mock proxies **throw** on access to an undefined `default` export,
  so probing `mod.default` breaks every `vi.mock('undici')` test;
- mocks built as `{ ...actual }` may carry a `default` key alongside named
  exports and must not be unwrapped.

## Why two helpers (not one exported from core)

cli and core resolve **different** undici copies. If cli code called a
core-hosted `loadUndici()`, the `import('undici')` would resolve inside
core's package scope, escaping `vi.mock('undici')` in cli tests — mocks
silently stop intercepting (observed: `ProxyAgent` mock never called in
`setup-github.test.ts`). Keeping one helper per package keeps each package's
tests able to mock their own undici.

## Guard

`scripts/check-serve-fast-path-bundle.js` adds undici to
`FORBIDDEN_ACP_PACKAGES`: a static re-import anywhere in the ACP eager
closure fails CI. After the change the eager closure drops from 15.42 MiB /
132 chunks to 13.39 MiB / 130 chunks, undici bytes 2057 KiB → 0; the bundle
retains exactly two dynamic undici entry chunks (one per package copy), both
behind the normalizing helpers.

## Acceptance (2C4G, #4748 discipline)

30 paired serial cold starts, control = phase 2 build, candidate = this
change: process→first-session paired P50 −89.5 ms (1336.8 → 1255.2),
candidate faster in 30/30 pairs; preheated path unchanged (P50 80.7 → 78.0);
RSS after first session −8.1 MB. Functional gates (concurrency, telemetry
disabled, legacy single-session) all pass. Full numbers in
`.qwen/e2e-tests/phase3-lazy-undici-bench-results.md`.

## Alternatives rejected

- **Single shared helper exported from core**: breaks cli test mocks and
  couples cli's copy of undici to core's (the two copies are already on
  different versions at HEAD: 7.27.2 vs 7.28.0).
- **Eager top-level preload kicked off at startup**: keeps the parse cost
  off the critical path only if nothing awaits it, but the whole point is
  that most cold starts never need undici before first-session; preloading
  would re-add the CPU contention on 2 cores that phase 2 measured.
- **Replacing undici usage with global `fetch`**: Node's global fetch is
  undici, but the code needs `Agent`/`ProxyAgent`/`EnvHttpProxyAgent`
  dispatcher options that the global surface does not expose.
