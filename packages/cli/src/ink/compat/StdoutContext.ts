/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { createContext } from 'react';

export type Props = {
  /**
   * Stdout stream passed to `render()` in `options.stdout` or `process.stdout`
   * by default.
   */
  readonly stdout: NodeJS.WriteStream;
  /**
   * Write any string to stdout while preserving Ink's output. Useful for
   * displaying external information outside of Ink's rendering.
   */
  readonly write: (data: string) => void;
};

/**
 * `StdoutContext` is a React context that exposes the stdout stream.
 *
 * This is a compat shim: the ink engine does not provide a StdoutContext, so
 * we create one here with sensible defaults (process.stdout). The
 * `useStdout` hook reads from this context.
 *
 * If you need to supply a custom stdout stream, wrap your tree with
 * `<StdoutContext.Provider value={{ stdout, write }}>`.
 */
const StdoutContext = createContext<Props>({
  stdout: process.stdout,
  write: (data: string) => {
    process.stdout.write(data);
  },
});

StdoutContext.displayName = 'InternalStdoutContext';

export default StdoutContext;
