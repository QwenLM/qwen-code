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
  getEffectivePermissionForConfirmation,
  needsConfirmation,
  isPlanModeBlocked,
  isAutoEditApproved,
} from './permissionFlow.js';
import { AskUserQuestionTool } from '../tools/askUserQuestion.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { applySkillAllowedTools } from '../tools/skill-utils.js';

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

  it('passes invocation permission aliases to the permission manager', async () => {
    const legacyName = 'mcp__server__legacy_name';
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockResolvedValue('allow'),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
    };
    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
      permissionAliases: [legacyName],
    });

    await evaluatePermissionFlow(
      mockConfig({
        getPermissionManager: vi.fn().mockReturnValue(mockPm),
      }),
      invocation,
      'mcp__server__provider_safe_name',
      {},
    );

    expect(mockPm.hasRelevantRules).toHaveBeenCalledWith(
      expect.objectContaining({ toolAliases: [legacyName] }),
    );
  });

  it('filters ambiguous MCP aliases through the registry and carries raw identity', async () => {
    const legacyName = 'mcp__srv__foo_bar';
    const rawName = 'mcp__srv__foo/bar';
    const aliasResolver = vi.fn().mockReturnValue([]);
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockResolvedValue('allow'),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
    };
    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
      permissionAliases: [legacyName],
    });
    Object.assign(invocation, { serverName: 'srv', serverToolName: 'foo/bar' });

    await evaluatePermissionFlow(
      mockConfig({
        getPermissionManager: vi.fn().mockReturnValue(mockPm),
        getToolRegistry: vi.fn().mockReturnValue({
          getUnambiguousMcpPermissionAliases: aliasResolver,
        }) as unknown as Config['getToolRegistry'],
      }),
      invocation,
      'mcp__srv__foo_bar_0cnn7di',
      {},
    );

    expect(aliasResolver).toHaveBeenCalledWith('mcp__srv__foo_bar_0cnn7di', [
      legacyName,
    ]);
    expect(mockPm.hasRelevantRules).toHaveBeenCalledWith(
      expect.objectContaining({ toolAliases: [rawName] }),
    );
  });

  it('falls back safely when a registry mock lacks the alias resolver', async () => {
    const legacyName = 'mcp__srv__foo_bar';
    const rawName = 'mcp__srv__foo/bar';
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockResolvedValue('allow'),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
    };
    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
      permissionAliases: [legacyName],
    });
    Object.assign(invocation, { serverName: 'srv', serverToolName: 'foo/bar' });

    const result = await evaluatePermissionFlow(
      mockConfig({
        getPermissionManager: vi.fn().mockReturnValue(mockPm),
        getToolRegistry: vi
          .fn()
          .mockReturnValue({}) as unknown as Config['getToolRegistry'],
      }),
      invocation,
      'mcp__srv__foo_bar_0cnn7di',
      {},
    );

    expect(result.pmCtx.toolAliases).toEqual([rawName]);
    expect(result.pmCtx.toolAliases).not.toContain(legacyName);
  });

  it('forces interaction even when PM allows the tool', async () => {
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockResolvedValue('allow'),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
    };
    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
      requiresUserInteraction: vi.fn().mockReturnValue(true),
    });

    const result = await evaluatePermissionFlow(
      mockConfig({ getPermissionManager: vi.fn().mockReturnValue(mockPm) }),
      invocation,
      ToolNames.EXIT_PLAN_MODE,
      { plan: 'Plan' },
    );

    expect(result.finalPermission).toBe('ask');
    expect(result.requiresUserInteraction).toBe(true);
  });

  it('preserves an intrinsic deny for an interaction-required tool', async () => {
    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('deny'),
      requiresUserInteraction: vi.fn().mockReturnValue(true),
    });

    const result = await evaluatePermissionFlow(
      mockConfig(),
      invocation,
      ToolNames.EXIT_PLAN_MODE,
      { plan: 'Plan' },
    );

    expect(result.finalPermission).toBe('deny');
  });

  it('preserves a permission-rule deny for an interaction-required tool', async () => {
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockResolvedValue('deny'),
      findMatchingDenyRule: vi.fn().mockReturnValue('deny exit_plan_mode'),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
    };
    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
      requiresUserInteraction: vi.fn().mockReturnValue(true),
    });

    const result = await evaluatePermissionFlow(
      mockConfig({ getPermissionManager: vi.fn().mockReturnValue(mockPm) }),
      invocation,
      ToolNames.EXIT_PLAN_MODE,
      { plan: 'Plan' },
    );

    expect(result.finalPermission).toBe('deny');
    expect(result.denyMessage).toContain('denied by permission rules');
  });
});

describe('evaluatePermissionFlow with ask_user_question', () => {
  const questions = [
    {
      question: 'Which check defines success?',
      header: 'Check',
      options: [
        { label: 'npm test', description: 'exit code 0' },
        { label: 'npm run lint', description: 'no warnings' },
      ],
      multiSelect: false,
    },
  ];

  const askConfig = (interactive: boolean) =>
    ({
      isInteractive: vi.fn().mockReturnValue(interactive),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getTargetDir: vi.fn().mockReturnValue('/test'),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      getInputFormat: vi.fn().mockReturnValue(undefined),
    }) as unknown as Config;

  const pmWithSkillGrant = () => {
    const pm = new PermissionManager({
      getPermissionsAllow: () => [],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => [],
      getApprovalMode: () => ApprovalMode.DEFAULT,
    });
    pm.initialize();
    // Exactly what loading a skill whose SKILL.md lists
    // `allowedTools: [ask_user_question]` does to the session.
    applySkillAllowedTools(pm, [ToolNames.ASK_USER_QUESTION]);
    return pm;
  };

  it("keeps the dialog when a skill's allowedTools grant would otherwise allow the tool", async () => {
    const config = askConfig(true);
    const pm = pmWithSkillGrant();
    const invocation = new AskUserQuestionTool(config).build({ questions });

    const result = await evaluatePermissionFlow(
      { ...config, getPermissionManager: () => pm } as unknown as Config,
      invocation,
      ToolNames.ASK_USER_QUESTION,
      { questions },
    );

    // The grant did override the 'ask' default at L4 …
    expect(result.defaultPermission).toBe('ask');
    expect(await pm.evaluate(result.pmCtx)).toBe('allow');
    // … but the invocation still reaches the user, in every approval mode.
    expect(result.requiresUserInteraction).toBe(true);
    expect(result.finalPermission).toBe('ask');
    expect(
      needsConfirmation(
        result.finalPermission,
        ApprovalMode.YOLO,
        ToolNames.ASK_USER_QUESTION,
        result.requiresUserInteraction,
      ),
    ).toBe(true);
  });

  it('still lets headless runs skip the tool, where nothing can prompt', async () => {
    const config = askConfig(false);
    const pm = pmWithSkillGrant();
    const invocation = new AskUserQuestionTool(config).build({ questions });

    const result = await evaluatePermissionFlow(
      { ...config, getPermissionManager: () => pm } as unknown as Config,
      invocation,
      ToolNames.ASK_USER_QUESTION,
      { questions },
    );

    expect(result.requiresUserInteraction).toBe(false);
    expect(result.finalPermission).toBe('allow');
  });

  it('preserves an explicit deny rule for ask_user_question', async () => {
    const config = askConfig(true);
    const pm = new PermissionManager({
      getPermissionsAllow: () => [],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => [ToolNames.ASK_USER_QUESTION],
      getApprovalMode: () => ApprovalMode.DEFAULT,
    });
    pm.initialize();
    const invocation = new AskUserQuestionTool(config).build({ questions });

    const result = await evaluatePermissionFlow(
      { ...config, getPermissionManager: () => pm } as unknown as Config,
      invocation,
      ToolNames.ASK_USER_QUESTION,
      { questions },
    );

    expect(result.finalPermission).toBe('deny');
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

  it('requires confirmation in YOLO when the invocation requires interaction', () => {
    expect(needsConfirmation('ask', ApprovalMode.YOLO, 'shell', true)).toBe(
      true,
    );
  });

  it('never requests confirmation for a hard deny', () => {
    expect(needsConfirmation('deny', ApprovalMode.YOLO, 'shell', true)).toBe(
      false,
    );
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

describe('getEffectivePermissionForConfirmation', () => {
  it('forces protected allow-rule fallback through manual confirmation', () => {
    expect(getEffectivePermissionForConfirmation('allow', true)).toBe('ask');
  });

  it('preserves ordinary permission decisions', () => {
    expect(getEffectivePermissionForConfirmation('allow', false)).toBe('allow');
    expect(getEffectivePermissionForConfirmation('ask', true)).toBe('ask');
    expect(getEffectivePermissionForConfirmation('default', true)).toBe(
      'default',
    );
    expect(getEffectivePermissionForConfirmation('deny', true)).toBe('deny');
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

  it('should not block enter_plan_mode tool', () => {
    expect(
      isPlanModeBlocked(
        true,
        false,
        false,
        mockConfirmationDetails('exec'),
        true,
      ),
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
