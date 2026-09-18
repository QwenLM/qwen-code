# Web Shell published package artifacts

Issue: #12185

## Public package verification

1. Install the locked dependencies with the documented Node 22/npm toolchain and build the workspace prerequisites.
2. Build `packages/web-shell`, run its boundary tests and `npm run verify:package --workspace=packages/web-shell`.
3. Both public library modes must externalize declared runtime dependencies, including MCP Apps. Keep the KaTeX and xterm stylesheet entrypoints bundled.
4. Re-emit declarations without alias rewriting. The package verifier must reject the unresolved `@/` imports. Restore the rewritten declarations and require verification to pass.
5. Temporarily remove an exported entrypoint. The prepublish guard must reject it; restore it and require success.
6. Pack the real SDK and Web Shell artifacts. Install them in an external consumer without repository aliases, resolve all exported entrypoints, type-check the consumer, and bundle the public root and transcript entries. Repeat module resolution through a symlinked consumer.

## Read-only document verification

The standalone document build substitutes the daemon-only MCP App bridge, not the public package. Its existing recorded-text fallback must remain visible without a daemon URL. Interactive Web Shell consumers must keep the real bridge.

1. Run the MCP App DOM suites, including the no-daemon fallback regression.
2. Build the real document renderer and retain its metafile. The existing 1,930,000-byte budget, CSS extraction, and structural dependency guards must pass unchanged. MCP Apps and the MCP SDK must not be inputs to this document-only build.
3. Keep the public transcript externalization but restore the previous document builder as a negative control. Record its real size/failure; restore the corrected builder and require success. Do not increase the budget or call unrelated build errors a successful negative control.
4. Render an exported document containing a recorded MCP result in a browser. Confirm the fallback text appears, no MCP iframe or daemon request is created, and no page error occurs. Retain genuine output or screenshots.
5. Run `npm run preflight` and report each command's actual result against the exact source SHA. Skipped checks and old-head results are not passes.

## Evidence policy

Record Node/package-manager versions, dependency layout, source/base/tested SHAs, command exit codes, and measured sizes. The earlier 1,912,420-byte note was not exact-current-tree acceptance: validation 35364652552 measured 1,987,668 bytes and failed. A fresh baseline comparison is required before attributing that difference to the patch or package manager. Fork verification does not replace upstream required checks.
