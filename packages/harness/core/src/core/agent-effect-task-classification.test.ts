/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import type { Terminal } from './query-event.js';
import {
  classifyTaskTerminal,
  PostCompactContextLimitError,
} from './agent-loop.js';
import {
  MalformedToolUseError,
  MalformedToolUseExhaustedError,
} from './malformed-tool-use.js';
import { InvalidStreamError } from './stream-errors.js';

function terminal(overrides: Partial<Terminal>): Terminal {
  return {
    reason: 'end_turn',
    numTurns: 1,
    usage: cloneUsage(),
    durationMs: 1,
    ...overrides,
  };
}

describe('Agent effect Task classification', () => {
  it.each([
    [
      terminal({ reason: 'abort', abortKind: 'aborted_streaming' }),
      1,
      { terminalReasonDetail: 'aborted_streaming' },
    ],
    [
      terminal({ reason: 'abort', abortKind: 'aborted_tools' }),
      1,
      { terminalReasonDetail: 'aborted_tools' },
    ],
    [
      terminal({ reason: 'abort' }),
      1,
      { terminalReasonDetail: 'unclassified_abort' },
    ],
    [
      terminal({ reason: 'repeated_tool_call_denied' }),
      1,
      { terminalReasonDetail: 'repeated_tool_call_denied' },
    ],
    [terminal({ reason: 'max_turns' }), 1, { terminalReasonDetail: 'max_turns' }],
    [
      terminal({ terminalDetail: 'hook_stopped' }),
      1,
      { terminalReasonDetail: 'hook_stopped' },
    ],
    [
      terminal({ modelStopReason: 'refusal' }),
      1,
      { terminalReasonDetail: 'model_refusal' },
    ],
    [
      terminal({ reason: 'error', error: new Error('prompt is too long') }),
      1,
      { terminalReasonDetail: 'prompt_too_long' },
    ],
    [
      terminal({
        reason: 'error',
        error: new PostCompactContextLimitError(),
      }),
      0,
      {
        terminalReasonDetail: 'post_compact_context_limit',
        errorKind: 'invalid_request',
      },
    ],
    [
      terminal({
        reason: 'error',
        error: new MalformedToolUseExhaustedError(),
      }),
      1,
      { terminalReasonDetail: 'malformed_tool_use_exhausted' },
    ],
    [
      terminal({
        reason: 'error',
        error: new InvalidStreamError('bad stream', 'NO_FINISH_REASON'),
      }),
      1,
      { terminalReasonDetail: 'model_error' },
    ],
    [
      terminal({ reason: 'error', error: new MalformedToolUseError() }),
      1,
      { terminalReasonDetail: 'model_error' },
    ],
    [
      terminal({ reason: 'error', error: Object.assign(new Error('429'), { status: 429 }) }),
      0,
      { terminalReasonDetail: 'turn_setup_failed', errorKind: 'rate_limit' },
    ],
    [
      terminal({ reason: 'error', error: Object.assign(new Error('500'), { status: 500 }) }),
      1,
      { terminalReasonDetail: 'api_error', errorKind: 'server_error' },
    ],
    [terminal({ reason: 'end_turn' }), 1, { terminalReasonDetail: 'completed' }],
  ] as const)(
    'maps a reachable terminal to one detail',
    (input, requestIndex, expected) => {
      expect(classifyTaskTerminal(input, requestIndex)).toEqual(expected);
    },
  );

  it('reports an explicit detail for an unclassified runtime error', () => {
    expect(
      classifyTaskTerminal(
        terminal({ reason: 'error', error: new Error('opaque') }),
        1,
      ),
    ).toEqual({ terminalReasonDetail: 'unclassified_error' });
  });

});
