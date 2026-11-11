/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/* eslint-disable custom-rules/no-top-level-side-effects */
// Must import the polyfill BEFORE react-devtools-core, which reads
// `window`, `self`, and `WebSocket` at module evaluation time.
// eslint-disable-next-line import-x/no-unassigned-import
import './devtools-window-polyfill.js';

// @ts-expect-error no types available
import devtools from 'react-devtools-core';

// Initialize the DevTools global hook (window.__REACT_DEVTOOLS_GLOBAL_HOOK__).
(devtools as any).initialize();

// Connect to the standalone React DevTools server.
// retryConnectionDelay is set very high to prevent reconnection loops:
// the standalone server only allows one connection at a time, so rapid
// retries create a cascade where each new connection kicks out the old one.
(devtools as any).connectToDevTools({
  retryConnectionDelay: 30 * 60 * 1000, // 30 min — effectively disabled
});
