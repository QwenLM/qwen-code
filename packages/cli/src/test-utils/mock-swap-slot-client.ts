/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';

/**
 * Stateful fake of the real GeminiClient's single swap-slot contract (see
 * beginTelemetrySwap's JSDoc in core client.ts): one open transaction at a
 * time; commit/abort release the slot. Shared by the /resume and /branch
 * hook tests so the contract has exactly one home — when it evolves,
 * updating this file updates both suites at once (#9844 review).
 *
 * `abortTelemetrySwap` models the real boolean return: true when the abort
 * settled an open transaction (an undo applied), false when nothing was
 * open. Modeling it makes "abort ran but restored nothing" observable —
 * the no-op case a stateless fake cannot distinguish from a restore.
 */
export function makeSwapSlotClient() {
  let open = false;
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    beginTelemetrySwap: vi.fn(() => {
      if (open) return false;
      open = true;
      return true;
    }),
    commitTelemetrySwap: vi.fn(() => {
      open = false;
    }),
    abortTelemetrySwap: vi.fn(() => {
      if (!open) return false;
      open = false;
      return true;
    }),
  };
}

export type SwapSlotClient = ReturnType<typeof makeSwapSlotClient>;
