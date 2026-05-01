/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../index.js';
import type { AnyToolInvocation } from '../index.js';
import { ApprovalMode, ToolNames } from '../index.js';
import type { ToolCallConfirmationDetails } from '../tools/tools.js';

// Import the functions we're testing
import {
  evaluatePermissionFlow,
  needsConfirmation,
  isPlanModeBlocked,
  isAutoEditApproved,
} from './permissionFlow.js';

// Mock types for testing
const mockConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    getPermissionManager: vi.fn().mockReturnValue(null),
    getTargetDir: vi.fn().mockReturnValue('/test'),
    getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
    ...overrides,
  }) as unknown as Config;

const mockInvocation = (
  overrides: Partial<AnyToolInvocation> = {},
): AnyToolInvocation =>
  ({
    getDefaultPermission: vi.fn().mockResolvedValue('ask'),
    getConfirmationDetails: vi.fn().mockResolvedValue({
      type: 'exec',
      title: 'Test',
      command: 'echo hello',
    }),
    params: {},
    ...overrides,
  }) as unknown as AnyToolInvocation;

describe('evaluatePermissionFlow', () => {
  it('should return deny result with correct message when defaultPermission is deny', async () => {
    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('deny'),
    });

    const result = await evaluatePermissionFlow(
      mockConfig(),
      invocation,
      'shell',
      { command: 'rm -rf /' },
    );

    expect(result.finalPermission).toBe('deny');
    expect(result.denyMessage).toContain("tool's default permission is 'deny'");
    expect(result.pmCtx).toBeDefined();
  });

  it('should return deny result with PM rule info when PM denies', async () => {
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockResolvedValue('deny'),
      findMatchingDenyRule: vi.fn().mockReturnValue('deny rm -rf *'),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
    };

    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
    });

    const config = mockConfig({
      getPermissionManager: vi.fn().mockReturnValue(mockPm),
    });

    const result = await evaluatePermissionFlow(config, invocation, 'shell', {
      command: 'rm -rf /',
    });

    expect(result.finalPermission).toBe('deny');
    expect(result.denyMessage).toContain('denied by permission rules');
    expect(result.denyMessage).toContain('Matching deny rule');
  });

  it('should return ask permission when PM has no relevant rules', async () => {
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(false),
    };

    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
    });

    const config = mockConfig({
      getPermissionManager: vi.fn().mockReturnValue(mockPm),
    });

    const result = await evaluatePermissionFlow(config, invocation, 'shell', {
      command: 'echo hello',
    });

    expect(result.finalPermission).toBe('ask');
    expect(result.denyMessage).toBeUndefined();
  });

  it('should set pmForcedAsk when PM has matching ask rule', async () => {
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockResolvedValue('ask'),
      hasMatchingAskRule: vi.fn().mockReturnValue(true),
    };

    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
    });

    const config = mockConfig({
      getPermissionManager: vi.fn().mockReturnValue(mockPm),
    });

    const result = await evaluatePermissionFlow(config, invocation, 'shell', {
      command: 'echo hello',
    });

    expect(result.finalPermission).toBe('ask');
    expect(result.pmForcedAsk).toBe(true);
  });
});

describe('needsConfirmation', () => {
  it('should return false for YOLO mode non-ask_user_question tools', () => {
    expect(needsConfirmation('ask', ApprovalMode.YOLO, 'shell')).toBe(false);
    expect(needsConfirmation('default', ApprovalMode.YOLO, 'read_file')).toBe(
      false,
    );
  });

  it('should return true for ask_user_question in YOLO mode', () => {
    expect(
      needsConfirmation('ask', ApprovalMode.YOLO, ToolNames.ASK_USER_QUESTION),
    ).toBe(true);
  });

  it('should return true when finalPermission is ask or default', () => {
    expect(needsConfirmation('ask', ApprovalMode.DEFAULT, 'shell')).toBe(true);
    expect(needsConfirmation('default', ApprovalMode.DEFAULT, 'shell')).toBe(
      true,
    );
  });

  it('should return false when finalPermission is allow or deny', () => {
    expect(needsConfirmation('allow', ApprovalMode.DEFAULT, 'shell')).toBe(
      false,
    );
    expect(needsConfirmation('deny', ApprovalMode.DEFAULT, 'shell')).toBe(
      false,
    );
  });
});

describe('isPlanModeBlocked', () => {
  const mockConfirmationDetails = (type: string): ToolCallConfirmationDetails =>
    ({ type }) as unknown as ToolCallConfirmationDetails;

  it('should block non-info tools in plan mode', () => {
    expect(
      isPlanModeBlocked(true, false, false, mockConfirmationDetails('exec')),
    ).toBe(true);

    expect(
      isPlanModeBlocked(true, false, false, mockConfirmationDetails('edit')),
    ).toBe(true);
  });

  it('should not block info-type tools in plan mode', () => {
    expect(
      isPlanModeBlocked(true, false, false, mockConfirmationDetails('info')),
    ).toBe(false);
  });

  it('should not block exit_plan_mode tool', () => {
    expect(
      isPlanModeBlocked(true, true, false, mockConfirmationDetails('exec')),
    ).toBe(false);
  });

  it('should not block ask_user_question tool', () => {
    expect(
      isPlanModeBlocked(true, false, true, mockConfirmationDetails('exec')),
    ).toBe(false);
  });

  it('should not block when not in plan mode', () => {
    expect(
      isPlanModeBlocked(false, false, false, mockConfirmationDetails('exec')),
    ).toBe(false);
  });
});

describe('isAutoEditApproved', () => {
  const mockConfirmationDetails = (type: string): ToolCallConfirmationDetails =>
    ({ type }) as unknown as ToolCallConfirmationDetails;

  it('should auto-approve edit-type tools in AUTO_EDIT mode', () => {
    expect(
      isAutoEditApproved(
        ApprovalMode.AUTO_EDIT,
        mockConfirmationDetails('edit'),
      ),
    ).toBe(true);
  });

  it('should auto-approve info-type tools in AUTO_EDIT mode', () => {
    expect(
      isAutoEditApproved(
        ApprovalMode.AUTO_EDIT,
        mockConfirmationDetails('info'),
      ),
    ).toBe(true);
  });

  it('should not auto-approve exec-type tools in AUTO_EDIT mode', () => {
    expect(
      isAutoEditApproved(
        ApprovalMode.AUTO_EDIT,
        mockConfirmationDetails('exec'),
      ),
    ).toBe(false);
  });

  it('should not auto-approve in non-AUTO_EDIT mode', () => {
    expect(
      isAutoEditApproved(ApprovalMode.DEFAULT, mockConfirmationDetails('edit')),
    ).toBe(false);
  });
});
