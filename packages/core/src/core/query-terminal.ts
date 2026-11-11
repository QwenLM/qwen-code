/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isPromptTooLongError } from '../compression-v2/ptl-retry.js';
import { REPEATED_TOOL_CALL_TERMINAL_REASON } from '../tool-executor/index.js';
import {
  MalformedToolUseError,
  MalformedToolUseExhaustedError,
} from './malformed-tool-use.js';
import type { Terminal } from './query-event.js';
import { classifyStopFailureError, InvalidStreamError } from './stream-errors.js';

export type TaskTerminalReasonDetail =
  | 'aborted_streaming'
  | 'aborted_tools'
  | 'repeated_tool_call_denied'
  | 'max_turns'
  | 'hook_stopped'
  | 'model_refusal'
  | 'prompt_too_long'
  | 'post_compact_context_limit'
  | 'malformed_tool_use_exhausted'
  | 'model_error'
  | 'turn_setup_failed'
  | 'api_error'
  | 'unclassified_error'
  | 'unclassified_abort'
  | 'unclassified_terminal'
  | 'completed';

export interface TaskTerminalClassification {
  terminalReasonDetail?: TaskTerminalReasonDetail;
  errorKind?: ReturnType<typeof classifyStopFailureError>;
}

/**
 * Legacy name and code retained for compatibility. This guard now
 * runs only when automatic context recovery is unavailable.
 */
export class PostCompactContextLimitError extends Error {
  readonly code = 'POST_COMPACT_CONTEXT_LIMIT';

  constructor() {
    super(
      'Context exceeds the limit and automatic context recovery is unavailable. Run /compact or /clear, then retry.',
    );
    this.name = 'PostCompactContextLimitError';
  }
}

export function classifyTaskTerminal(
  terminal: Terminal,
  requestIndex: number,
): TaskTerminalClassification {
  if (terminal.reason === 'abort' && terminal.abortKind) {
    return { terminalReasonDetail: terminal.abortKind };
  }
  if (terminal.reason === REPEATED_TOOL_CALL_TERMINAL_REASON) {
    return { terminalReasonDetail: 'repeated_tool_call_denied' };
  }
  if (terminal.reason === 'max_turns') {
    return { terminalReasonDetail: 'max_turns' };
  }
  if (terminal.terminalDetail === 'hook_stopped') {
    return { terminalReasonDetail: 'hook_stopped' };
  }
  if (terminal.error instanceof PostCompactContextLimitError) {
    return {
      terminalReasonDetail: 'post_compact_context_limit',
      errorKind: 'invalid_request',
    };
  }
  if (terminal.modelStopReason === 'refusal') {
    return { terminalReasonDetail: 'model_refusal' };
  }
  if (isPromptTooLongError(terminal.error)) {
    return { terminalReasonDetail: 'prompt_too_long' };
  }
  if (terminal.error instanceof MalformedToolUseExhaustedError) {
    return { terminalReasonDetail: 'malformed_tool_use_exhausted' };
  }
  if (
    terminal.error instanceof InvalidStreamError ||
    terminal.error instanceof MalformedToolUseError
  ) {
    return { terminalReasonDetail: 'model_error' };
  }
  if (terminal.reason === 'error') {
    const errorKind = classifyStopFailureError(terminal.error);
    if (requestIndex === 0) {
      return {
        terminalReasonDetail: 'turn_setup_failed',
        ...(errorKind !== 'unknown' ? { errorKind } : {}),
      };
    }
    if (errorKind !== 'unknown') {
      return {
        terminalReasonDetail: 'api_error',
        errorKind,
      };
    }
    return { terminalReasonDetail: 'unclassified_error' };
  }
  if (terminal.reason === 'end_turn') {
    return { terminalReasonDetail: 'completed' };
  }
  if (terminal.reason === 'abort') {
    return { terminalReasonDetail: 'unclassified_abort' };
  }
  // Concrete fallback: an absent field would stay indistinguishable from clients that report no detail.
  return { terminalReasonDetail: 'unclassified_terminal' };
}
