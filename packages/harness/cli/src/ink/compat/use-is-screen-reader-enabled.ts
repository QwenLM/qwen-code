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
 * Compat shim for ink's `useIsScreenReaderEnabled()` hook.
 *
 * The real ink hook reads from a context that is populated when a screen
 * reader is detected (typically via the `FORCE_COLOR=0` / accessibility env
 * vars or OS-level AT detection). The ink engine does not wire up that
 * detection, so this shim returns `false` unconditionally, which is the
 * correct safe default (i.e. render the rich TUI, not the simplified
 * screen-reader output).
 *
 * If the engine ever adds proper screen-reader detection, this hook can be updated
 * to read from the relevant context without changing call-sites.
 */
const useIsScreenReaderEnabled = (): boolean => {
  return false;
};

export default useIsScreenReaderEnabled;
