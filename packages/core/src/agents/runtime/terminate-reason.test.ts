/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  describeAgentTerminateReason,
  terminateReasonMessage,
} from './terminate-reason.js';
import { AgentTerminateMode } from './agent-types.js';
import { LoopType } from '../../telemetry/types.js';

describe('describeAgentTerminateReason', () => {
  it.each([
    [AgentTerminateMode.MAX_TURNS, 'Agent stopped: maximum turns reached.'],
    [AgentTerminateMode.TIMEOUT, 'Agent stopped: time limit reached.'],
    [AgentTerminateMode.ERROR, 'Agent stopped due to an error.'],
    [
      AgentTerminateMode.LOOP_DETECTED,
      'Agent stopped: duplicate tool-call loop detected.',
    ],
  ])('words %s', (mode, expected) => {
    expect(describeAgentTerminateReason(mode)).toBe(expected);
  });

  it('names the detector when the loop type is known', () => {
    expect(
      describeAgentTerminateReason(
        AgentTerminateMode.LOOP_DETECTED,
        LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      ),
    ).toBe(
      'Agent stopped: duplicate tool-call loop detected (consecutive_identical_tool_calls).',
    );
  });

  it.each([
    AgentTerminateMode.CANCELLED,
    AgentTerminateMode.SHUTDOWN,
    AgentTerminateMode.GOAL,
  ])('leaves %s to the caller', (mode) => {
    expect(describeAgentTerminateReason(mode)).toBeUndefined();
  });
});

describe('terminateReasonMessage', () => {
  it('replaces a known mode with its wording', () => {
    expect(
      terminateReasonMessage(
        AgentTerminateMode.MAX_TURNS,
        'Dream agent failed',
      ),
    ).toBe('Agent stopped: maximum turns reached.');
  });

  it('passes an unrecognized reason through unchanged', () => {
    expect(
      terminateReasonMessage('Model timed out', 'Dream agent failed'),
    ).toBe('Model timed out');
  });

  it.each(['toString', 'constructor', 'valueOf'])(
    'passes %s through instead of mistaking it for a mode',
    (reason) => {
      // Inherited keys answer `in` but not `hasOwn`; only the latter
      // matches what the token check claims to test.
      expect(terminateReasonMessage(reason, 'Dream agent failed')).toBe(reason);
    },
  );

  it('falls back to the caller text when there is no reason', () => {
    expect(terminateReasonMessage(undefined, 'Dream agent failed')).toBe(
      'Dream agent failed',
    );
  });

  it('falls back rather than reporting an empty reason', () => {
    expect(terminateReasonMessage('', 'Dream agent failed')).toBe(
      'Dream agent failed',
    );
  });

  it.each(Object.values(AgentTerminateMode))(
    'never reports %s as the message',
    (mode) => {
      expect(terminateReasonMessage(mode, 'Dream agent failed')).not.toBe(mode);
    },
  );

  it.each([AgentTerminateMode.CANCELLED, AgentTerminateMode.SHUTDOWN])(
    'uses the caller text for %s',
    (mode) => {
      expect(terminateReasonMessage(mode, 'Dream agent cancelled')).toBe(
        'Dream agent cancelled',
      );
    },
  );
});
