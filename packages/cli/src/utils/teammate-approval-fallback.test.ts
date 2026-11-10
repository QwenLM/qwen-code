/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import {
  decideTeammateApprovalFallback,
  type TeammateApprovalHostCopy,
} from './teammate-approval-fallback.js';

const host: TeammateApprovalHostCopy = {
  surface: 'test mode',
  explicitApprovalHint: 'EXPLICIT_HINT',
  allowHint: 'ALLOW_HINT',
};
const base = { teammateName: 'worker', toolName: 'run_shell_command' };
const explicit = {
  ...base,
  confirmationDetails: { type: 'exec', hideAlwaysAllow: true } as never,
};

describe('decideTeammateApprovalFallback', () => {
  it('proceeds in YOLO when no explicit approval is required', () => {
    expect(
      decideTeammateApprovalFallback(base, ApprovalMode.YOLO, host),
    ).toEqual({ action: 'proceed' });
  });

  it('cancels outside YOLO with the allow hint', () => {
    const decision = decideTeammateApprovalFallback(
      base,
      ApprovalMode.DEFAULT,
      host,
    );
    expect(decision).toEqual({
      action: 'cancel',
      reason:
        'Auto-cancelling tool run_shell_command requested by teammate "worker": current approval mode (default) cannot prompt in test mode. ALLOW_HINT',
    });
  });

  it('cancels an explicit-approval request even in YOLO', () => {
    const decision = decideTeammateApprovalFallback(
      explicit,
      ApprovalMode.YOLO,
      host,
    );
    expect(decision).toMatchObject({
      action: 'cancel',
      reason: expect.stringContaining('cannot be bypassed by YOLO mode'),
    });
  });

  it('points an explicit-approval request outside YOLO at the host hint', () => {
    const decision = decideTeammateApprovalFallback(
      explicit,
      ApprovalMode.DEFAULT,
      host,
    );
    expect(decision).toMatchObject({
      action: 'cancel',
      reason: expect.stringContaining('unavailable in test mode'),
    });
    expect((decision as { reason: string }).reason).toMatch(/EXPLICIT_HINT$/);
  });
});
