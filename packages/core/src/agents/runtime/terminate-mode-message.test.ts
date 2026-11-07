/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { LoopType } from '../../telemetry/types.js';
import { AgentTerminateMode } from './agent-types.js';
import {
  describeTerminateReason,
  terminateModeMessage,
} from './terminate-mode-message.js';

describe('terminateModeMessage', () => {
  it('maps the turn cap to a warning', () => {
    expect(terminateModeMessage(AgentTerminateMode.MAX_TURNS)).toEqual({
      text: 'Agent stopped: maximum turns reached.',
      level: 'warning',
    });
  });

  it('maps the time limit to a warning', () => {
    expect(terminateModeMessage(AgentTerminateMode.TIMEOUT)).toEqual({
      text: 'Agent stopped: time limit reached.',
      level: 'warning',
    });
  });

  it('maps an error to an error', () => {
    expect(terminateModeMessage(AgentTerminateMode.ERROR)).toEqual({
      text: 'Agent stopped due to an error.',
      level: 'error',
    });
  });

  it('names the loop detector when one is known', () => {
    expect(
      terminateModeMessage(
        AgentTerminateMode.LOOP_DETECTED,
        LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      ),
    ).toEqual({
      text: 'Agent stopped: duplicate tool-call loop detected (consecutive_identical_tool_calls).',
      level: 'error',
    });
  });

  it('falls back to a generic loop message without a detector', () => {
    expect(terminateModeMessage(AgentTerminateMode.LOOP_DETECTED)).toEqual({
      text: 'Agent stopped: duplicate tool-call loop detected.',
      level: 'error',
    });
  });

  it('suppresses modes the caller reports elsewhere', () => {
    expect(terminateModeMessage(AgentTerminateMode.CANCELLED)).toBeNull();
    expect(terminateModeMessage(AgentTerminateMode.SHUTDOWN)).toBeNull();
    expect(terminateModeMessage(AgentTerminateMode.GOAL)).toBeNull();
  });

  it('suppresses a missing or unknown reason', () => {
    expect(terminateModeMessage(undefined)).toBeNull();
    expect(terminateModeMessage('SOMETHING_ELSE')).toBeNull();
  });
});

describe('describeTerminateReason', () => {
  it('never surfaces the raw terminate-mode token', () => {
    for (const mode of [
      AgentTerminateMode.MAX_TURNS,
      AgentTerminateMode.TIMEOUT,
      AgentTerminateMode.ERROR,
      AgentTerminateMode.LOOP_DETECTED,
    ]) {
      const text = describeTerminateReason(mode, 'Agent failed');
      expect(text).not.toContain(mode);
      expect(text).toBe(terminateModeMessage(mode)?.text);
    }
  });

  it('uses the caller fallback for a suppressed mode', () => {
    expect(
      describeTerminateReason(
        AgentTerminateMode.CANCELLED,
        'Dream agent cancelled before completion',
      ),
    ).toBe('Dream agent cancelled before completion');
  });

  it('uses the caller fallback when no reason is reported', () => {
    expect(describeTerminateReason(undefined, 'Remember agent failed')).toBe(
      'Remember agent failed',
    );
  });

  it('passes a free-form reason through unchanged', () => {
    expect(describeTerminateReason('Model timed out', 'Agent failed')).toBe(
      'Model timed out',
    );
  });
});
