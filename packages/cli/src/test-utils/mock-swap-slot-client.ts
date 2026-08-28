/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';

/**
 * Stateful fake of the real LlmClient's single swap-slot contract (see
 * beginTelemetrySwap's JSDoc in core client.ts): one open transaction at a
 * time; commit/abort release the slot. Shared by the /resume and /branch
 * hook tests so the contract has exactly one home — when it evolves,
 * updating this file updates both suites at once (#9844 review).
 *
 * `abortTelemetrySwap` models HALF of the real boolean return: true when a
 * transaction was open, false when nothing was open. The real client
 * additionally returns false when the open transaction never armed an undo
 * ("abort with an open but unarmed transaction is a no-op" in
 * client.telemetrySwap.test.ts) — the fake cannot observe initialize()'s
 * replay decision, so it over-approximates. Tests must therefore not
 * assert the true return for shapes where the forward initialize() never
 * ran; assert the call counts and the commit-vs-abort choice instead
 * (#9844 review).
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
