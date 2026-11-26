/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { TurnTiming } from '../utils/turnTiming.js';

export class RequestPreparationTiming {
  readonly turn: TurnTiming;

  constructor(submittedAt: number, now: () => number = () => performance.now()) {
    this.turn = new TurnTiming(submittedAt, now);
  }
}
