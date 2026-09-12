/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { GOAL_CHECKPOINT_STALL_LIMIT } from '@qwen-code/qwen-code-core';
import { GOAL_CHECKPOINT_STALL_LIMIT as SDK_GOAL_CHECKPOINT_STALL_LIMIT } from '@qwen-code/sdk/daemon';

// The Web Shell renders the checkpoint stall streak against the SDK's
// hand-duplicated copy of this limit, while the runtime stops a Goal at
// Core's. The SDK has no dependency path to Core, so pin the two copies here,
// where both packages are importable: a drift would show users the wrong N/3
// rather than fail a build.
describe('goal checkpoint stall limit wire contract', () => {
  it('is identical across core and the SDK', () => {
    expect(SDK_GOAL_CHECKPOINT_STALL_LIMIT).toBe(GOAL_CHECKPOINT_STALL_LIMIT);
  });
});
