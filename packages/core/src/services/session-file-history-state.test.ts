/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  ChatRecord,
  FileHistorySnapshotRecordPayload,
} from './chatRecordingService.js';
import { MAX_SNAPSHOTS } from './fileHistoryService.js';
import { SessionFileHistoryAccumulator } from './session-file-history-state.js';

function snapshotRecord(
  snapshots: FileHistorySnapshotRecordPayload['snapshots'],
): Pick<ChatRecord, 'type' | 'subtype' | 'systemPayload'> {
  return {
    type: 'system',
    subtype: 'file_history_snapshot',
    systemPayload: { snapshots },
  };
}

function snapshot(promptId: string, timestamp: string) {
  return {
    promptId,
    timestamp,
    trackedFileBackups: {},
  };
}

describe('SessionFileHistoryAccumulator', () => {
  it('keeps the final 100 first-insertion slots with retained replacements', () => {
    const accumulator = new SessionFileHistoryAccumulator();
    accumulator.add(
      snapshotRecord(
        Array.from({ length: MAX_SNAPSHOTS + 1 }, (_, index) =>
          snapshot(
            `prompt-${index}`,
            `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
          ),
        ),
      ),
    );
    accumulator.add(
      snapshotRecord([
        snapshot('prompt-0', '2026-02-01T00:00:00.000Z'),
        snapshot('prompt-50', '2026-03-01T00:00:00.000Z'),
      ]),
    );

    const restored = accumulator.finish();

    expect(restored).toHaveLength(MAX_SNAPSHOTS);
    expect(restored?.map((item) => item.promptId)).toEqual(
      Array.from(
        { length: MAX_SNAPSHOTS },
        (_, index) => `prompt-${index + 1}`,
      ),
    );
    expect(
      restored?.find((item) => item.promptId === 'prompt-50')?.timestamp,
    ).toEqual(new Date('2026-03-01T00:00:00.000Z'));
  });

  it('does not partially apply a malformed snapshot batch', () => {
    const accumulator = new SessionFileHistoryAccumulator();
    accumulator.add(
      snapshotRecord([snapshot('before', '2026-01-01T00:00:00.000Z')]),
    );

    expect(() =>
      accumulator.add(
        snapshotRecord([
          snapshot('partial', '2026-01-02T00:00:00.000Z'),
          {
            promptId: 'malformed',
            timestamp: '2026-01-03T00:00:00.000Z',
            trackedFileBackups: null,
          } as never,
        ]),
      ),
    ).toThrow();

    expect(accumulator.finish()?.map((item) => item.promptId)).toEqual([
      'before',
    ]);
  });
});
