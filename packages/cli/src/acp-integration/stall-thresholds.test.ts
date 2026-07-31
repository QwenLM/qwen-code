/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ACP_EVENT_LOOP_STALL_RESTART_MS } from '@qwen-code/channel-base';
import { DEFAULT_EVENT_LOOP_SUSPEND_THRESHOLD_MS } from '@qwen-code/qwen-code-core';

describe('acp stall thresholds', () => {
  // The ACP agent starts its event-loop lag monitor with default options
  // (acpAgent.ts), while AcpBridge kills the child once a reported stall
  // reaches ACP_EVENT_LOOP_STALL_RESTART_MS. If the suspend threshold ever
  // exceeded the kill threshold, a host sleep in between the two values would
  // be reported as a stall and kill a healthy child on wake.
  it('keeps host-suspension filtering at or below the bridge stall-kill threshold', () => {
    expect(DEFAULT_EVENT_LOOP_SUSPEND_THRESHOLD_MS).toBeLessThanOrEqual(
      ACP_EVENT_LOOP_STALL_RESTART_MS,
    );
  });
});
