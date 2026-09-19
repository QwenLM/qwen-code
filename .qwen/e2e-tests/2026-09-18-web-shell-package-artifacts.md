# Web Shell published package artifacts

Issue: #12185

## Public package verification

1. Install the locked dependencies with the documented Node 22/npm toolchain and build the workspace prerequisites.
2. Build `packages/web-shell` and run the focused package-boundary and built-artifact suites.
3. All declared runtime JavaScript dependencies and subpaths must remain external in the published entries. Dependency stylesheet subpaths must stay bundled so the package's scoped CSS injector can ship their styles.
4. Run the upstream `scripts/verify-publish-artifacts.mjs` prepublish guard merged in #12188. It must reject missing export targets or repository-only declaration aliases; do not duplicate that verifier in this branch.
5. Pack the real SDK and Web Shell artifacts. Install them in an external consumer without repository aliases, resolve all exported entrypoints, and repeat module resolution through a symlinked consumer.

## Read-only document verification

The standalone document build substitutes the daemon-only MCP App bridge, not the public package. Its existing recorded-text fallback must remain visible without a daemon URL. Interactive Web Shell consumers must keep the real bridge.

1. Run the MCP App DOM suites, including the no-daemon fallback regression.
2. Build the real document renderer and retain its metafile. The structural dependency guards and byte ceiling must pass. MCP Apps and the MCP SDK must not be inputs to this document-only build.
3. Keep the public transcript externalization but restore the previous document builder as a negative control. Record its real size/failure; restore the corrected builder and require success. Do not increase the budget or call unrelated build errors a successful negative control.
4. Render an exported document containing a recorded MCP result in a browser. Confirm the fallback text appears, no MCP iframe or daemon request is created, and no page error occurs. Retain genuine output or screenshots.
5. Run `npm run preflight` and report each command's actual result against the exact source SHA. Skipped checks and old-head results are not passes.

## Evidence policy

Record Node/package-manager versions, dependency layout, source/base/tested SHAs, command exit codes, and measured sizes. Fork verification does not replace upstream required checks. A failing repository-wide preflight must be classified from its exact assertion and compared with the appropriate baseline before assigning causality.
