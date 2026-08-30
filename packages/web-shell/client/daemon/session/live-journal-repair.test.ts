/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  findLiveJournalRepairSuffix,
  findLiveJournalRepairTarget,
  resolveLiveJournalMarkerPromptId,
} from './live-journal-repair.js';

const marker = (promptId?: string): DaemonEvent => ({
  v: 1,
  type: 'history_truncated',
  ...(promptId ? { promptId } : {}),
  data: {
    reason: 'replay_window_exceeded',
    scope: 'live_journal',
    truncatedEvents: 4,
    retainedEvents: 2,
    maxBytes: 1024,
    maxEvents: 2,
    fullTranscriptAvailable: true,
  },
});

const update = (
  id: number,
  promptId: string,
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk',
): DaemonEvent => ({
  id,
  v: 1,
  type: 'session_update',
  promptId,
  data: {
    update: {
      sessionUpdate,
      content: { type: 'text', text: `${sessionUpdate}-${id}` },
    },
  },
});

describe('live journal repair validation', () => {
  it('prefers marker promptId and falls back only to a unique retained prompt', () => {
    expect(
      findLiveJournalRepairTarget(
        'session-1',
        [
          marker('prompt-authoritative'),
          update(5, 'prompt-other', 'agent_message_chunk'),
        ],
        5,
        false,
      )?.promptId,
    ).toBe('prompt-authoritative');
    expect(
      findLiveJournalRepairTarget(
        'session-1',
        [marker(), update(5, 'prompt-fallback', 'agent_message_chunk')],
        5,
        false,
      )?.promptId,
    ).toBe('prompt-fallback');
    expect(
      findLiveJournalRepairTarget(
        'session-1',
        [
          marker(),
          update(5, 'prompt-a', 'agent_message_chunk'),
          update(6, 'prompt-b', 'agent_message_chunk'),
        ],
        6,
        false,
      ),
    ).toBeUndefined();
  });

  it('resolves marker ownership independently of recoverability', () => {
    const unavailableMarker = marker('prompt-owned');
    unavailableMarker.data = {
      ...(unavailableMarker.data as Record<string, unknown>),
      fullTranscriptAvailable: false,
    };
    expect(
      resolveLiveJournalMarkerPromptId(unavailableMarker, [
        unavailableMarker,
        update(5, 'prompt-other', 'agent_message_chunk'),
      ]),
    ).toBe('prompt-owned');
    const unownedMarker = marker();
    expect(
      resolveLiveJournalMarkerPromptId(unownedMarker, [
        unownedMarker,
        update(5, 'prompt-fallback', 'agent_message_chunk'),
      ]),
    ).toBe('prompt-fallback');
  });

  it('rejects degraded or non-recoverable live markers', () => {
    expect(
      findLiveJournalRepairTarget('session-1', [marker('prompt-1')], 5, true),
    ).toBeUndefined();
    const unavailableMarker = marker('prompt-1');
    unavailableMarker.data = {
      reason: 'replay_window_exceeded',
      scope: 'live_journal',
      truncatedEvents: 4,
      retainedEvents: 2,
      maxBytes: 1024,
      maxEvents: 2,
      fullTranscriptAvailable: false,
    };
    expect(
      findLiveJournalRepairTarget('session-1', [unavailableMarker], 5, false),
    ).toBeUndefined();

    for (const malformedData of [
      { maxEvents: -1 },
      { maxEvents: 1.5 },
      { truncatedEvents: '4' },
    ]) {
      const malformedMarker = marker('prompt-1');
      malformedMarker.data = {
        ...(malformedMarker.data as Record<string, unknown>),
        ...malformedData,
      };
      expect(
        findLiveJournalRepairTarget('session-1', [malformedMarker], 5, false),
      ).toBeUndefined();
    }
  });

  it('requires the target user input and matching formal terminal', () => {
    const replay = [
      update(1, 'prompt-1', 'user_message_chunk'),
      update(2, 'prompt-1', 'agent_message_chunk'),
      {
        id: 3,
        v: 1,
        type: 'turn_complete',
        promptId: 'prompt-1',
        data: { promptId: 'prompt-1', stopReason: 'end_turn' },
      },
      update(4, 'prompt-2', 'user_message_chunk'),
    ] satisfies DaemonEvent[];

    expect(findLiveJournalRepairSuffix(replay, 'prompt-1')).toEqual({
      events: replay,
      terminal: replay[2],
    });
    expect(
      findLiveJournalRepairSuffix(replay.slice(1), 'prompt-1'),
    ).toBeUndefined();
    expect(
      findLiveJournalRepairSuffix(replay.slice(0, 2), 'prompt-1'),
    ).toBeUndefined();
    expect(findLiveJournalRepairSuffix(replay, 'prompt-2')).toBeUndefined();
  });
});
