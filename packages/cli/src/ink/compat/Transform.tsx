/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * Transform component — compatibility shim.
 *
 * The original ink Transform component applies a string transformation to each
 * line of rendered output. The rendering engine doesn't support this mechanism
 * (it uses packed Int32Array frame buffers, not string-per-line rendering).
 *
 * This shim renders children as-is. Third-party plugins like ink-gradient will
 * still work but produce plain (un-transformed) text. This is acceptable since
 * gradient effects are purely cosmetic.
 */
import { type ReactNode } from 'react';

interface TransformProps {
  /**
   * Function to transform each line of output (ignored in the ink engine).
   */
  transform: (line: string, index: number) => string;
  children?: ReactNode;
}

export default function Transform({ children }: TransformProps) {
  return <>{children}</>;
}

export { Transform };
export type { TransformProps };
