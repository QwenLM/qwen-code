/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import type { Config } from '../../config/config.js';
import { TmuxBackend } from './TmuxBackend.js';
import { InProcessBackend } from './InProcessBackend.js';
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
 * Detection priority:
 * 1. User explicit preference (--display=in-process|tmux|iterm2)
 * 2. Auto-detect:
 *    - inside tmux: TmuxBackend
 *    - other terminals: tmux external session mode when tmux is available
 *    - fallback to InProcessBackend
 *
 * @param preference - Optional display mode preference
 * @param runtimeContext - Runtime config for in-process fallback
 */
export async function detectBackend(
  preference: DisplayMode | undefined,
  runtimeContext: Config,
): Promise<DetectBackendResult> {
  // 1. User explicit preference
  if (preference === DISPLAY_MODE.IN_PROCESS) {
    debugLogger.info('Using InProcessBackend (user preference)');
    return { backend: new InProcessBackend(runtimeContext) };
  }

  if (preference === DISPLAY_MODE.ITERM2) {
    throw new Error(
      `Arena display mode "${DISPLAY_MODE.ITERM2}" is not implemented yet. Please use "${DISPLAY_MODE.TMUX}" or "${DISPLAY_MODE.IN_PROCESS}".`,
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

  // Fallback: use InProcessBackend
  debugLogger.info(
    'No PTY backend available — falling back to InProcessBackend',
  );
  return {
    backend: new InProcessBackend(runtimeContext),
    warning:
      'tmux is not available. Using in-process mode (no split-pane terminal view).',
  };
}
