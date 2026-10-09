/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ChatRecord } from './chatRecordingService.js';
import { computeInitialTurnFromHistory } from './session-turn-state.js';

const T0 = '2026-01-01T00:00:00.000Z';

function snapshotRecord(sessionId: string, promptIds: string[]): ChatRecord {
  return {
    uuid: 'snapshot-1',
    parentUuid: null,
    sessionId,
    timestamp: T0,
    cwd: '/tmp/session-turn-state',
    version: '1.0.0',
    type: 'system',
    subtype: 'file_history_snapshot',
    systemPayload: {
      snapshots: promptIds.map((promptId) => ({
        promptId,
        timestamp: T0,
        trackedFileBackups: {},
      })),
    },
  };
}

describe('computeInitialTurnFromHistory', () => {
  it('ignores retained snapshot ordinals without a safe successor', () => {
    const sessionId = 's';
    const record = snapshotRecord(sessionId, [
      `${sessionId}########12`,
      `${sessionId}########${'9'.repeat(400)}`,
      `${sessionId}########9007199254740992`,
      `${sessionId}########${Number.MAX_SAFE_INTEGER}`,
    ]);

    expect(computeInitialTurnFromHistory([record], sessionId)).toBe(12);
  });
});
