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
import StdinContext from '../components/StdinContext.js';

export type StdinProps = {
  /**
   * The stdin stream passed to `render()` in `options.stdin`, or
   * `process.stdin` by default. Useful if your app needs to handle user input.
   */
  readonly stdin: NodeJS.ReadStream;
  /**
   * Ink exposes this function via its own `<StdinContext>` to handle Ctrl+C.
   * Use this instead of `process.stdin.setRawMode`. If the `stdin` stream does
   * not support setRawMode, this function does nothing.
   */
  readonly setRawMode: (value: boolean) => void;
  /**
   * A boolean flag indicating whether the current `stdin` supports
   * `setRawMode`. Useful for graceful fallback in non-TTY environments.
   */
  readonly isRawModeSupported: boolean;
};

/**
 * Compat shim for ink's `useStdin()` hook.
 *
 * The core engine's `hooks/use-stdin` already reads from `StdinContext`, but it re-exports
 * the full internal context shape (including `internal_eventEmitter`,
 * `internal_exitOnCtrlC`, `internal_querier`) which differs from GMN's ink
 * `StdinContext` shape (Node's `EventEmitter` vs the engine's custom one).
 *
 * This shim exposes only the stable public surface that GMN components depend
 * on: `{ stdin, setRawMode, isRawModeSupported }`.
 */
const useStdin = (): StdinProps => {
  const { stdin, setRawMode, isRawModeSupported } = useContext(StdinContext);
  return { stdin, setRawMode, isRawModeSupported };
};

export default useStdin;
