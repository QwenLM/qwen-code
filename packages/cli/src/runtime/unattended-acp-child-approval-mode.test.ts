/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import {
  hasExplicitApprovalModeCliArg,
  resolveUnattendedAcpChildApprovalMode,
  tryParseApprovalModePin,
} from './unattended-acp-child-approval-mode.js';

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

  it('does not elevate an explicitly chosen default (argv / set_mode)', () => {
    expect(
      resolveUnattendedAcpChildApprovalMode(
        ApprovalMode.DEFAULT,
        undefined,
        false,
        { explicitlyChosen: true },
      ),
    ).toBe(ApprovalMode.DEFAULT);
  });

  it('honors an explicit plan pin by its own value, not the live mode', () => {
    // Live mode YOLO must not override an on-disk plan pin (R2-2).
    expect(
      resolveUnattendedAcpChildApprovalMode(ApprovalMode.YOLO, 'plan', false),
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

  it('fails closed to default for a present but unparseable pin', () => {
    expect(
      resolveUnattendedAcpChildApprovalMode(
        ApprovalMode.DEFAULT,
        'auto edit',
        false,
      ),
    ).toBe(ApprovalMode.DEFAULT);
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
      resolveUnattendedAcpChildApprovalMode(
        ApprovalMode.YOLO,
        undefined,
        false,
      ),
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

describe('tryParseApprovalModePin', () => {
  it('accepts canonical ids and auto_edit aliases', () => {
    expect(tryParseApprovalModePin('plan')).toBe(ApprovalMode.PLAN);
    expect(tryParseApprovalModePin('AUTO')).toBe(ApprovalMode.AUTO);
    expect(tryParseApprovalModePin('auto_edit')).toBe(ApprovalMode.AUTO_EDIT);
    expect(tryParseApprovalModePin('autoedit')).toBe(ApprovalMode.AUTO_EDIT);
  });

  it('returns undefined for unrecognized spellings', () => {
    expect(tryParseApprovalModePin('auto edit')).toBeUndefined();
    expect(tryParseApprovalModePin('safe')).toBeUndefined();
  });
});

describe('hasExplicitApprovalModeCliArg', () => {
  it('detects --approval-mode, --yolo, and -y', () => {
    expect(hasExplicitApprovalModeCliArg(['node', 'qwen', '--acp'])).toBe(
      false,
    );
    expect(
      hasExplicitApprovalModeCliArg([
        'node',
        'qwen',
        '--acp',
        '--approval-mode',
        'default',
      ]),
    ).toBe(true);
    expect(
      hasExplicitApprovalModeCliArg([
        'node',
        'qwen',
        '--acp',
        '--approval-mode=plan',
      ]),
    ).toBe(true);
    expect(hasExplicitApprovalModeCliArg(['node', 'qwen', '--acp', '-y'])).toBe(
      true,
    );
    expect(
      hasExplicitApprovalModeCliArg(['node', 'qwen', '--acp', '--yolo']),
    ).toBe(true);
  });
});
