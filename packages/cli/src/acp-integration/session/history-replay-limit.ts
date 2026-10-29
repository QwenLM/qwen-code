/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export class HistoryReplayLimitError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: 'bytes' | 'updates',
    readonly observed: number,
    readonly limit: number,
  ) {
    super(
      `Transcript replay for session ${sessionId} exceeds the ${reason} limit (${observed}, max ${limit}). Use a recent replay or paged history.`,
    );
    this.name = 'HistoryReplayLimitError';
  }
}
