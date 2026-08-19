/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  formatBoardPending,
  BOARD_POLL_INTERVAL_MS,
} from './use-board-pending.js';

describe('board pending indicator', () => {
  it('shows nothing when the session is on no board', () => {
    expect(formatBoardPending(null)).toBeUndefined();
  });

  // An empty board is the steady state. Showing "board demo" with no counts
  // would occupy the footer permanently to say nothing.
  it('shows nothing when the board is quiet', () => {
    expect(
      formatBoardPending({ board: 'demo', asks: 0, decisions: 0 }),
    ).toBeUndefined();
  });

  // A decision blocks everyone until a person acts; an ask blocks one peer.
  it('puts decisions first and marks them', () => {
    expect(formatBoardPending({ board: 'demo', asks: 2, decisions: 1 })).toBe(
      'board demo ⚠ 1 ? 2',
    );
  });

  it('shows either kind alone', () => {
    expect(formatBoardPending({ board: 'demo', asks: 3, decisions: 0 })).toBe(
      'board demo ? 3',
    );
    expect(formatBoardPending({ board: 'demo', asks: 0, decisions: 1 })).toBe(
      'board demo ⚠ 1',
    );
  });

  // Below what a person notices, and one readdir plus a few small reads —
  // the same order as `sessions ps`. Cheap enough that an idle session can
  // stay responsive without anything being pushed to it.
  it('polls often enough to feel immediate without being a socket', () => {
    expect(BOARD_POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
    expect(BOARD_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
  });
});
