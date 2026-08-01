/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import {
  getDecisionFromOutcome,
  ToolCallDecision,
} from './tool-call-decision.js';

describe('getDecisionFromOutcome', () => {
  it('records switch-to-Default approval as a one-time acceptance', () => {
    expect(
      getDecisionFromOutcome(
        ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
      ),
    ).toBe(ToolCallDecision.ACCEPT);
  });
});
