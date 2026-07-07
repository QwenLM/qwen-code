/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  TotalSessionLimitExceededError,
  type BridgeFreshSessionAdmission,
  type BridgeFreshSessionReservation,
} from './acp-session-bridge.js';

interface SessionCountSource {
  readonly sessionCount: number;
}

export interface TotalSessionAdmissionOptions {
  readonly maxTotalSessions?: number;
  readonly getBridges: () => readonly SessionCountSource[];
}

export interface TotalSessionAdmissionSnapshot {
  readonly inFlight: number;
}

export interface TotalSessionAdmissionController {
  readonly admit: BridgeFreshSessionAdmission;
  readonly snapshot: () => TotalSessionAdmissionSnapshot;
}

export function createTotalSessionAdmissionController({
  maxTotalSessions,
  getBridges,
}: TotalSessionAdmissionOptions): TotalSessionAdmissionController {
  let inFlight = 0;
  const limit =
    maxTotalSessions === undefined ||
    maxTotalSessions === 0 ||
    maxTotalSessions === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : maxTotalSessions;

  return {
    admit(): BridgeFreshSessionReservation {
      if (limit !== Number.POSITIVE_INFINITY) {
        const live = getBridges().reduce(
          (sum, bridge) => sum + bridge.sessionCount,
          0,
        );
        if (live + inFlight >= limit) {
          throw new TotalSessionLimitExceededError(limit);
        }
      }

      inFlight++;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          inFlight--;
        },
      };
    },
    snapshot() {
      return { inFlight };
    },
  };
}
