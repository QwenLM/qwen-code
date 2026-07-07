/**
 * Shim: replaces the bundled `abort-controller@3` polyfill with Node's native
 * `AbortController` / `AbortSignal` globals. Paired with `node-fetch.cjs` to
 * eliminate the signal-class realm mismatch (see comments there).
 *
 * Wired in via esbuild's `--alias:abort-controller=...` flag.
 */
module.exports = {
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
}
module.exports.default = module.exports
