/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import {
  didToolCallProduceWork,
  operationCancelledErrorMessage,
  OPERATION_CANCELLED_PREFIX,
  TOOL_CANCELLED_AFTER_COMPLETION_MESSAGE,
  TOOL_CANCELLED_BEFORE_COMPLETION_MESSAGE,
} from './tool-result-markers.js';

function cancelledParts(reason: string): Part[] {
  return [
    {
      functionResponse: {
        id: 'c',
        name: 'write_file',
        response: { error: operationCancelledErrorMessage(reason) },
      },
    },
  ];
}

describe('tool result markers', () => {
  it('formats cancellation errors under the shared prefix', () => {
    const message = operationCancelledErrorMessage('user abort');
    expect(message).toBe('[Operation Cancelled] Reason: user abort');
    expect(message.startsWith(OPERATION_CANCELLED_PREFIX)).toBe(true);
  });

  it.each([
    ['success', { status: 'success' }, true],
    ['executed error', { status: 'error', executionStatus: 'error' }, true],
    [
      'never started error',
      { status: 'error', executionStatus: 'not_started' },
      false,
    ],
    [
      'never started cancellation',
      { status: 'cancelled', executionStatus: 'not_started' },
      false,
    ],
    [
      'before-completion cancellation',
      {
        status: 'cancelled',
        executionStatus: 'cancelled',
        responseParts: cancelledParts(TOOL_CANCELLED_BEFORE_COMPLETION_MESSAGE),
      },
      false,
    ],
    [
      'after-completion cancellation',
      {
        status: 'cancelled',
        executionStatus: 'cancelled',
        responseParts: cancelledParts(TOOL_CANCELLED_AFTER_COMPLETION_MESSAGE),
      },
      true,
    ],
    [
      'after-completion cancellation with hook context',
      {
        status: 'cancelled',
        executionStatus: 'success',
        responseParts: cancelledParts(
          `${TOOL_CANCELLED_AFTER_COMPLETION_MESSAGE}\n\nhook context`,
        ),
      },
      true,
    ],
    ['unknown cancellation', { status: 'cancelled', responseParts: [] }, false],
  ] satisfies Array<
    [string, Parameters<typeof didToolCallProduceWork>[0], boolean]
  >)('%s', (_label, outcome, expected) => {
    expect(didToolCallProduceWork(outcome)).toBe(expected);
  });
});
