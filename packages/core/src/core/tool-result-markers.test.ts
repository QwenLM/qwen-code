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
  PERMISSION_DECLINED_MESSAGE_PREFIX,
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

describe('operationCancelledErrorMessage', () => {
  it('embeds the reason under the shared prefix', () => {
    expect(operationCancelledErrorMessage('user abort')).toBe(
      '[Operation Cancelled] Reason: user abort',
    );
    expect(
      operationCancelledErrorMessage('x').startsWith(
        OPERATION_CANCELLED_PREFIX,
      ),
    ).toBe(true);
  });
});

describe('didToolCallProduceWork', () => {
  it('counts success and genuine error outcomes', () => {
    expect(didToolCallProduceWork({ status: 'success' })).toBe(true);
    expect(
      didToolCallProduceWork({
        status: 'error',
        executionStatus: 'error',
      }),
    ).toBe(true);
  });

  it('does not count never-executed outcomes (not_started)', () => {
    // Policy denials and pre-execution cancellations: the tool never ran,
    // regardless of the terminal status the scheduler reported.
    expect(
      didToolCallProduceWork({
        status: 'error',
        executionStatus: 'not_started',
        responseParts: [
          {
            functionResponse: {
              id: 'c',
              name: 'write_file',
              response: {
                error: `${PERMISSION_DECLINED_MESSAGE_PREFIX} "write_file", but that permission was declined.`,
              },
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      didToolCallProduceWork({
        status: 'cancelled',
        executionStatus: 'not_started',
      }),
    ).toBe(false);
  });

  it('does not count before-completion cancellations', () => {
    expect(
      didToolCallProduceWork({
        status: 'cancelled',
        executionStatus: 'cancelled',
        responseParts: cancelledParts(TOOL_CANCELLED_BEFORE_COMPLETION_MESSAGE),
      }),
    ).toBe(false);
  });

  it('counts after-completion cancellations (side effects landed)', () => {
    // Primary production shape: the scheduler reports executionStatus
    // 'cancelled' for the aborted after-completion path
    // (coreToolScheduler: executionStatus = aborted ? 'cancelled' : …).
    expect(
      didToolCallProduceWork({
        status: 'cancelled',
        executionStatus: 'cancelled',
        responseParts: cancelledParts(TOOL_CANCELLED_AFTER_COMPLETION_MESSAGE),
      }),
    ).toBe(true);
    // The scheduler appends PostToolUseFailure-hook additionalContext after
    // the marker; the match must survive the suffix.
    expect(
      didToolCallProduceWork({
        status: 'cancelled',
        executionStatus: 'cancelled',
        responseParts: cancelledParts(
          `${TOOL_CANCELLED_AFTER_COMPLETION_MESSAGE}\n\nhook additional context`,
        ),
      }),
    ).toBe(true);
    expect(
      didToolCallProduceWork({
        status: 'cancelled',
        executionStatus: 'success',
        responseParts: cancelledParts(TOOL_CANCELLED_AFTER_COMPLETION_MESSAGE),
      }),
    ).toBe(true);
  });

  it('treats a cancelled outcome without a recognizable marker as never-run', () => {
    // Fail-safe direction: unknown cancellation shapes do not inflate the
    // skill-review window.
    expect(
      didToolCallProduceWork({ status: 'cancelled', responseParts: [] }),
    ).toBe(false);
  });
});
