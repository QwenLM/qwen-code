/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { resolveUnattendedAcpChildApprovalMode } from './unattended-acp-child-approval-mode.js';

describe('resolveUnattendedAcpChildApprovalMode', () => {
  it('elevates the implicit ACP ask-permissions boot default to auto', () => {
    expect(
      resolveUnattendedAcpChildApprovalMode(
        ApprovalMode.DEFAULT,
        undefined,
        false,
      ),
    ).toBe(ApprovalMode.AUTO);
  });

  it('honors an explicit plan pin', () => {
    expect(
      resolveUnattendedAcpChildApprovalMode(
        ApprovalMode.PLAN,
        'plan',
        false,
      ),
    ).toBe(ApprovalMode.PLAN);
  });

  it('honors an explicit default pin without escalating to auto', () => {
    expect(
      resolveUnattendedAcpChildApprovalMode(
        ApprovalMode.DEFAULT,
        'default',
        false,
      ),
    ).toBe(ApprovalMode.DEFAULT);
  });

  it('honors an explicit auto pin', () => {
    expect(
      resolveUnattendedAcpChildApprovalMode(ApprovalMode.AUTO, 'auto', false),
    ).toBe(ApprovalMode.AUTO);
  });

  it('keeps restricted (safe/bare) sessions on default', () => {
    expect(
      resolveUnattendedAcpChildApprovalMode(
        ApprovalMode.DEFAULT,
        undefined,
        true,
      ),
    ).toBe(ApprovalMode.DEFAULT);
    expect(
      resolveUnattendedAcpChildApprovalMode(ApprovalMode.PLAN, 'plan', true),
    ).toBe(ApprovalMode.DEFAULT);
    expect(
      resolveUnattendedAcpChildApprovalMode(ApprovalMode.AUTO, 'auto', true),
    ).toBe(ApprovalMode.DEFAULT);
  });

  it('passes through a non-default effective mode when nothing is pinned', () => {
    expect(
      resolveUnattendedAcpChildApprovalMode(ApprovalMode.YOLO, undefined, false),
    ).toBe(ApprovalMode.YOLO);
    expect(
      resolveUnattendedAcpChildApprovalMode(
        ApprovalMode.AUTO_EDIT,
        undefined,
        false,
      ),
    ).toBe(ApprovalMode.AUTO_EDIT);
  });
});
