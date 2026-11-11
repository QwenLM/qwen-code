/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { useContext } from 'react';
import StdoutContext, { type Props } from './StdoutContext.js';

/**
 * Compat shim for ink's `useStdout()` hook.
 *
 * The real ink hook reads from a `StdoutContext` that is populated by ink's
 * own `<App>` component. The ink engine does not provide that context, so
 * this shim reads from the compat `StdoutContext` (which falls back to
 * `process.stdout` when no provider is present).
 *
 * Returns `{ stdout, write }`:
 *   - `stdout` — the NodeJS.WriteStream where Ink renders its output.
 *   - `write(data)` — helper to write a raw string to stdout while preserving
 *     Ink's output (equivalent to the ink original).
 */
const useStdout = (): Props => useContext(StdoutContext);

export default useStdout;
