/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  GOAL_PAUSE_REASON_COMMAND,
  validateGoalPauseReason,
} from '@qwen-code/qwen-code-core';
import { GOAL_PAUSE_REASON_COMMAND as SDK_GOAL_PAUSE_REASON_COMMAND } from '@qwen-code/sdk/daemon';

// The Web Shell pauses through the SDK's hand-duplicated wire types, which
// carry their own copy of this reason so the SDK stays independent of Core.
// The daemon validates what arrives against Core's rules, so the two copies
// have to agree -- and the SDK has no dependency path to Core, so pin the
// contract here, where both packages are importable.
describe('goal pause reason wire contract', () => {
  it('is identical across core and the SDK', () => {
    expect(SDK_GOAL_PAUSE_REASON_COMMAND).toBe(GOAL_PAUSE_REASON_COMMAND);
  });

  it('passes the validator the daemon applies to it', () => {
    expect(validateGoalPauseReason(SDK_GOAL_PAUSE_REASON_COMMAND)).toBeNull();
  });
});
