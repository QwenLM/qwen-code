/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import { TmuxBackend } from './TmuxBackend.js';
import { type Backend, DISPLAY_MODE, type DisplayMode } from './types.js';
import { isTmuxAvailable } from './tmux-commands.js';

const debugLogger = createDebugLogger('BACKEND_DETECT');

export interface DetectBackendResult {
  backend: Backend;
  warning?: string;
}

/**
 * Detect and create the appropriate Backend.
 *
 * Design principle for current Arena flow:
 * - Keep all display mode values in the API surface
 * - Only tmux is runnable for now
 * - in-process / iTerm2 preferences fail fast as "not implemented yet"
 *
 * Detection priority:
 * 1. User explicit preference (--display=in-process|tmux|iterm2)
 * 2. Auto-detect:
 *    - inside tmux: TmuxBackend
 *    - other terminals: tmux external session mode when tmux is available
 */
export async function detectBackend(
  preference?: DisplayMode,
): Promise<DetectBackendResult> {
  // 1. User explicit preference
  if (preference === DISPLAY_MODE.IN_PROCESS) {
    throw new Error(
      `Arena display mode "${DISPLAY_MODE.IN_PROCESS}" is not implemented yet. Please use "${DISPLAY_MODE.TMUX}".`,
    );
  }

  if (preference === DISPLAY_MODE.ITERM2) {
    throw new Error(
      `Arena display mode "${DISPLAY_MODE.ITERM2}" is not implemented yet. Please use "${DISPLAY_MODE.TMUX}".`,
    );
  }

  if (preference === DISPLAY_MODE.TMUX) {
    debugLogger.info('Using TmuxBackend (user preference)');
    return { backend: new TmuxBackend() };
  }

  // 2. Auto-detect
  if (process.env['TMUX']) {
    debugLogger.info('Detected $TMUX — attempting TmuxBackend');
    return { backend: new TmuxBackend() };
  }

  // Other terminals (including iTerm2): use tmux external session mode if available.
  if (isTmuxAvailable()) {
    debugLogger.info(
      'tmux is available — using TmuxBackend external session mode',
    );
    return { backend: new TmuxBackend() };
  }

  // No supported backend available.
  const tmuxEnv = process.env['TMUX'];
  const termProgram = process.env['TERM_PROGRAM'];
  throw new Error(
    `No supported Arena backend detected. $TMUX=${tmuxEnv ? `"${tmuxEnv}"` : '(unset)'}, $TERM_PROGRAM=${termProgram ? `"${termProgram}"` : '(unset)'}. Install tmux to use Arena split-pane mode.`,
  );
}
