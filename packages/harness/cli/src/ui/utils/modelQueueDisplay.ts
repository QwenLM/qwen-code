/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { clamp } from '../../ink/layout/geometry.js';

export function formatEstimatedQueueWait(
  waitTimeMs: number | undefined,
): string | undefined {
  if (
    waitTimeMs === undefined ||
    !Number.isFinite(waitTimeMs) ||
    waitTimeMs < 0
  ) {
    return undefined;
  }
  if (waitTimeMs < 60_000) return 'estimated wait less than 1min';
  if (waitTimeMs < 120_000) return 'estimated wait 1min';
  if (waitTimeMs < 600_000) {
    return `estimated wait ${Math.round(waitTimeMs / 60_000)}min`;
  }
  return 'estimated wait over 10min';
}

export function getModelQueueBarWidth(
  terminalWidth: number,
  reservedWidth: number,
): number {
  return clamp(terminalWidth - reservedWidth, 10, 48);
}
