/**
 * Shim: replaces the bundled `node-fetch@2` with Electron/Node 18+ native `fetch`.
 *
 * Why: grammY's `shim.node.js` imports `node-fetch` and `abort-controller`.
 * When esbuild bundles `abort-controller`'s `class AbortSignal`, it renames it
 * to `_AbortSignal` to avoid collision with the global, which breaks
 * `node-fetch@2`'s check `signal.constructor.name === 'AbortSignal'`.
 *
 * Native `fetch` (undici) accepts the global `AbortSignal` natively and is
 * faster, so we sidestep both polyfills. This file is wired in via esbuild's
 * `--alias:node-fetch=...` flag in package.json's build:main script.
 */
module.exports = globalThis.fetch.bind(globalThis)
module.exports.default = globalThis.fetch.bind(globalThis)
module.exports.Headers = globalThis.Headers
module.exports.Request = globalThis.Request
module.exports.Response = globalThis.Response
