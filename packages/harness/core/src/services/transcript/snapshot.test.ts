/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptFileSnapshot } from './scanner.js';
import { sameTranscriptSnapshots } from './snapshot.js';

function snapshot(
  overrides: Partial<TranscriptFileSnapshot> = {},
): TranscriptFileSnapshot {
  return {
    device: 1,
    inode: 2,
    size: 3,
    modifiedTimeMs: 4,
    changedTimeMs: 5,
    ...overrides,
  };
}

describe('sameTranscriptSnapshots', () => {
  it('descriptor 一致时视为同一版本', () => {
    expect(sameTranscriptSnapshots(snapshot(), snapshot())).toBe(true);
  });

  it('任一侧缺少 ctime 时跳过 ctime 比较', () => {
    expect(
      sameTranscriptSnapshots(snapshot({ changedTimeMs: undefined }), snapshot()),
    ).toBe(true);
    expect(
      sameTranscriptSnapshots(snapshot(), snapshot({ changedTimeMs: undefined })),
    ).toBe(true);
  });

  it('身份、大小或时间变化时拒绝', () => {
    expect(sameTranscriptSnapshots(snapshot(), snapshot({ size: 4 }))).toBe(
      false,
    );
    expect(
      sameTranscriptSnapshots(snapshot(), snapshot({ modifiedTimeMs: 6 })),
    ).toBe(false);
    expect(
      sameTranscriptSnapshots(snapshot(), snapshot({ changedTimeMs: 7 })),
    ).toBe(false);
  });
});
