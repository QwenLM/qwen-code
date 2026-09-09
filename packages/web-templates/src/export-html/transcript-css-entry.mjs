/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The esbuild `onLoad` filter that identifies the Web Shell transcript entry
 * whose `__qwenWebShellCss` literal build.mjs lifts out into
 * `export-transcript-document.css`.
 *
 * Extracted from build.mjs for the same reason `scripts/sdk-node-exporter-stub.js`
 * exists: build.mjs is a top-level-await script with no harness, so the match
 * decision — the part that decides whether the stylesheet is extracted at all —
 * has to be unit-testable without running a full bundle.
 *
 * Both separators are in the class because esbuild hands plugin callbacks the
 * platform-native absolute path. On Windows that is
 * `C:\repo\packages\web-shell\dist\transcript.js`, so a forward-slash-only
 * pattern never matches there: the callback never runs, the extracted CSS stays
 * undefined, and the mandatory guard in build.mjs aborts every build — including
 * the one `npm ci` runs through the root `prepare` script.
 *
 * The `transcript\.js$` tail is load-bearing. FORBIDDEN_DOCUMENT_INPUTS bars
 * `web-shell/dist/index.js` because the package root drags the interactive shell
 * (App, daemon providers, editor/terminal chrome) into every export, so a bare
 * `web-shell[\\/]dist[\\/]` prefix would match the barred entry too and lift the
 * wrong stylesheet.
 */
export const TRANSCRIPT_CSS_ENTRY_FILTER =
  /web-shell[\\/]dist[\\/]transcript\.js$/;
