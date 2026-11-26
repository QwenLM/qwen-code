/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TurnTimingSnapshot {
  readonly submittedAtMs: number;
  readonly observedAtMs: number;
  readonly durationMs?: number;
}

export class TurnTiming {
  constructor(
    private readonly submittedAt: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  snapshot(): TurnTimingSnapshot {
    const observedAtMs = this.now();
    return Object.freeze({
      submittedAtMs: this.submittedAt,
      observedAtMs,
      ...(Number.isFinite(this.submittedAt) &&
      this.submittedAt >= 0 &&
      Number.isFinite(observedAtMs) &&
      observedAtMs >= this.submittedAt
        ? { durationMs: Math.round(observedAtMs - this.submittedAt) }
        : {}),
    });
  }
}
