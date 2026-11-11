/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

// Shared frame interval for render throttling and animations (~30fps).
// Terminal emulators typically render at 30fps or batch output, so 60fps
// yields no visual benefit while doubling CPU/layout work.
export const FRAME_INTERVAL_MS = 32;
