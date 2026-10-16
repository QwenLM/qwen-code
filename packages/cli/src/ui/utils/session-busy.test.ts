/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { TrackedToolCall } from '../hooks/useReactToolScheduler.js';
import { StreamingState } from '../types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { getSessionBusyMessage, getSessionBusyReason } from './session-busy.js';

function tool(status: TrackedToolCall['status'], submitted = false) {
  return {
    request: { name: 'run_shell_command' },
    status,
    responseSubmittedToLlm: submitted,
  } as TrackedToolCall;
}

describe('session busy diagnostics', () => {
  it('prioritizes compaction consistently over approvals', () => {
    const reason = getSessionBusyReason(
      StreamingState.WaitingForConfirmation,
      [tool('awaiting_approval')],
      false,
      true,
    );
    expect(reason).toBe(
      'context compaction is in progress. Wait for it to finish.',
    );
    const context = createMockCommandContext({
      ui: {
        readSessionBusyReason: () => 'a subagent is awaiting approval.',
        pendingItem: { type: 'compression', compression: { isPending: true } },
      },
    });
    expect(getSessionBusyMessage(context, 'fork')).toBe(
      `Cannot fork: ${reason}`,
    );
  });

  it('names the tool awaiting approval ahead of other activity', () => {
    expect(
      getSessionBusyReason(
        StreamingState.WaitingForConfirmation,
        [tool('executing'), tool('awaiting_approval')],
        false,
      ),
    ).toContain('tool "run_shell_command" is awaiting approval');
  });

  it('identifies a subagent approval', () => {
    expect(
      getSessionBusyReason(
        StreamingState.WaitingForConfirmation,
        [tool('executing')],
        false,
      ),
    ).toContain('a subagent is awaiting approval');
  });

  it.each(['executing', 'scheduled', 'validating'] as const)(
    'names a %s tool',
    (status) => {
      expect(
        getSessionBusyReason(StreamingState.Responding, [tool(status)], true),
      ).toContain(`tool "run_shell_command" is ${status}`);
    },
  );

  it.each(['success', 'error', 'cancelled'] as const)(
    'identifies an unsubmitted %s result',
    (status) => {
      expect(
        getSessionBusyReason(StreamingState.Responding, [tool(status)], false),
      ).toContain(
        'the result of tool "run_shell_command" has not been submitted',
      );
      expect(
        getSessionBusyReason(StreamingState.Idle, [tool(status, true)], false),
      ).toBeNull();
    },
  );

  it('distinguishes incoming content from a silent request', () => {
    expect(getSessionBusyReason(StreamingState.Responding, [], true)).toContain(
      'streaming a response',
    );
    expect(
      getSessionBusyReason(StreamingState.Responding, [], false),
    ).toContain('no response content arriving');
    expect(getSessionBusyReason(StreamingState.Idle, [], false)).toBeNull();
  });

  it('reads the live reason each time', () => {
    let reason: string | null = 'context compaction is in progress.';
    const context = createMockCommandContext({
      ui: { readSessionBusyReason: () => reason },
    });
    expect(getSessionBusyMessage(context, 'branch')).toContain('compaction');
    reason = null;
    expect(getSessionBusyMessage(context, 'branch')).toBeNull();
  });

  it('blocks pending compaction even when the stream is idle', () => {
    const context = createMockCommandContext({
      ui: {
        pendingItem: {
          type: 'compression',
          compression: { isPending: true },
        },
      },
    });
    expect(getSessionBusyMessage(context, 'fork')).toContain(
      'context compaction',
    );
  });

  it('blocks pending slash commands and clears once they finish', () => {
    const context = createMockCommandContext({
      ui: { pendingItem: { type: 'info', text: 'working' } },
    });
    expect(getSessionBusyMessage(context, 'change directory')).toContain(
      'slash command',
    );
    context.ui.pendingItem = null;
    expect(getSessionBusyMessage(context, 'change directory')).toBeNull();
  });

  it('ignores a completed compaction item', () => {
    const context = createMockCommandContext({
      ui: {
        pendingItem: {
          type: 'compression',
          compression: { isPending: false },
        },
      },
    });
    expect(getSessionBusyMessage(context, 'branch')).toBeNull();
  });
});
