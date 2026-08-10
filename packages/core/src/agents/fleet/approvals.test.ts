/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolConfirmationOutcome } from '../../tools/tools.js';
import { ApprovalRegistry } from './approvals.js';

describe('ApprovalRegistry', () => {
  it('answers each callId at most once', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const registry = new ApprovalRegistry();
    registry.register('call-1', respond);

    const decision = {
      callId: 'call-1',
      outcome: ToolConfirmationOutcome.ProceedOnce,
    };
    await registry.answer(decision);
    await registry.answer(decision);

    expect(respond).toHaveBeenCalledOnce();
  });
});
