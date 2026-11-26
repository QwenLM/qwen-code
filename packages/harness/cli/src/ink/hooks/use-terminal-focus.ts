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
import TerminalFocusContext from '../components/TerminalFocusContext.js';

/**
 * Hook to check if the terminal has focus.
 *
 * Uses DECSET 1004 focus reporting - the terminal sends escape sequences
 * when it gains or loses focus. These are handled automatically
 * by Ink and filtered from useInput.
 *
 * @returns true if the terminal is focused (or focus state is unknown)
 */
export function useTerminalFocus(): boolean {
  const { isTerminalFocused } = useContext(TerminalFocusContext);
  return isTerminalFocused;
}
