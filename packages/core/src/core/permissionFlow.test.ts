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

import {
  evaluatePermissionFlow,
  getEffectivePermissionForConfirmation,
  needsConfirmation,
  isPlanModeBlocked,
  isAutoEditApproved,
} from './permissionFlow.js';
import { AskUserQuestionTool } from '../tools/askUserQuestion.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { ShellToolInvocation } from '../tools/shell.js';
import { applySkillAllowedTools } from '../tools/skill-utils.js';

// The comment fast path is Bash-only, so pin the shell type the way
// `permission-manager.test.ts` does rather than depending on the host OS.
const shellTypeMock = vi.hoisted(() => ({ value: 'bash' as const }));
vi.mock('../utils/shell-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/shell-utils.js')>();
  return {
    ...actual,
    getShellConfiguration: () => ({
      ...actual.getShellConfiguration(),
      shell: shellTypeMock.value,
    }),
  };
});

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

// A permission-manager stub with relevant rules that evaluates to `verdict`;
// it has `findMatchingDenyRule` only when `denyRule` is given.
const mockPm = (verdict: string, denyRule?: string, askRule = false) => ({
  hasRelevantRules: vi.fn().mockReturnValue(true),
  evaluate: vi.fn().mockResolvedValue(verdict),
  ...(denyRule !== undefined
    ? { findMatchingDenyRule: vi.fn().mockReturnValue(denyRule) }
    : {}),
  hasMatchingAskRule: vi.fn().mockReturnValue(askRule),
});

// evaluatePermissionFlow under a config whose permission manager is `pm`.
const flowWithPm = (
  pm: unknown,
  toolName: string,
  params: Record<string, unknown>,
  invocation = mockInvocation(),
) =>
  evaluatePermissionFlow(
    mockConfig({ getPermissionManager: vi.fn().mockReturnValue(pm) }),
    invocation,
    toolName,
    params,
  );

const mockConfirmationDetails = (type: string): ToolCallConfirmationDetails =>
  ({ type }) as unknown as ToolCallConfirmationDetails;

describe('evaluatePermissionFlow', () => {
  it('passes caller cancellation to intrinsic permission evaluation', async () => {
    const invocation = mockInvocation();
    const controller = new AbortController();
    await evaluatePermissionFlow(
      mockConfig(),
      invocation,
      'Read',
      {},
      controller.signal,
    );
    expect(invocation.getDefaultPermission).toHaveBeenCalledWith(
      controller.signal,
    );
  });

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
    const result = await flowWithPm(mockPm('deny', 'deny rm -rf *'), 'shell', {
      command: 'rm -rf /',
    });

    expect(result.finalPermission).toBe('deny');
    expect(result.denyMessage).toContain('denied by permission rules');
    expect(result.denyMessage).toContain('Matching deny rule');
  });

  it('frames a specifier-scoped deny as invocation-scoped, not tool-scoped', async () => {
    const result = await flowWithPm(
      mockPm('deny', 'Bash(npm view *)'),
      'shell',
      { command: 'npm view foo' },
    );

    expect(result.finalPermission).toBe('deny');
    // The message must read as "this call was blocked", not "the tool is gone"
    // (issue #11405), and must reassure the model the tool is still usable.
    expect(result.denyMessage).toContain('invocation was denied');
    expect(result.denyMessage).toContain('Bash(npm view *)');
    expect(result.denyMessage).toContain(
      'Other uses of this tool are still permitted',
    );
  });

  it('does not reassure for tool-wide catch-all deny rules (#11405)', async () => {
    for (const raw of ['Bash(*)', 'Read(//**)', 'WebFetch(*)']) {
      const result = await flowWithPm(mockPm('deny', raw), 'shell', {
        command: 'echo hello',
      });

      // The rule is still cited …
      expect(result.denyMessage).toContain(`Matching deny rule: "${raw}"`);
      // … but a fully-blocked tool must not be told it can try other uses.
      expect(result.denyMessage).not.toContain(
        'Other uses of this tool are still permitted',
      );
    }
  });

  it('should return ask permission when PM has no relevant rules', async () => {
    const pm = { hasRelevantRules: vi.fn().mockReturnValue(false) };

    const result = await flowWithPm(pm, 'shell', { command: 'echo hello' });

    expect(result.finalPermission).toBe('ask');
    expect(result.denyMessage).toBeUndefined();
  });

  it('should set pmForcedAsk when PM has matching ask rule', async () => {
    const result = await flowWithPm(mockPm('ask', undefined, true), 'shell', {
      command: 'echo hello',
    });

    expect(result.finalPermission).toBe('ask');
    expect(result.pmForcedAsk).toBe(true);
  });

  it('passes invocation permission aliases to the permission manager', async () => {
    const legacyName = 'mcp__server__legacy_name';
    const pm = mockPm('allow');

    await flowWithPm(
      pm,
      'mcp__server__provider_safe_name',
      {},
      mockInvocation({ permissionAliases: [legacyName] }),
    );

    expect(pm.hasRelevantRules).toHaveBeenCalledWith(
      expect.objectContaining({ toolAliases: [legacyName] }),
    );
  });

  // A rule pinned to a derived value (the Workflow tool's script digest) must
  // be checked against the value the invocation computed, never a same-named
  // parameter the model supplied.
  it('matches rules against the parameters the invocation derives', async () => {
    const pm = mockPm('allow');
    const order: string[] = [];
    const modelParams = { name: 'audit', sha256: 'model-chosen' };
    const invocation = mockInvocation({
      params: modelParams,
      getDefaultPermission: vi.fn(async () => {
        order.push('default');
        return 'ask' as const;
      }),
      getPermissionMatchParams: vi.fn(() => {
        order.push('match');
        return { name: 'audit', sha256: 'derived' };
      }),
    });

    await flowWithPm(pm, ToolNames.WORKFLOW, modelParams, invocation);

    // Derived after the L3 check, which is where the value is computed.
    expect(order).toEqual(['default', 'match']);
    expect(pm.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolParams: { name: 'audit', sha256: 'derived' },
      }),
    );
  });

  it('forces interaction even when PM allows the tool', async () => {
    const result = await flowWithPm(
      mockPm('allow'),
      ToolNames.EXIT_PLAN_MODE,
      { plan: 'Plan' },
      mockInvocation({
        requiresUserInteraction: vi.fn().mockReturnValue(true),
      }),
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
    const result = await flowWithPm(
      mockPm('deny', 'deny exit_plan_mode'),
      ToolNames.EXIT_PLAN_MODE,
      { plan: 'Plan' },
      mockInvocation({
        requiresUserInteraction: vi.fn().mockReturnValue(true),
      }),
    );

    expect(result.finalPermission).toBe('deny');
    expect(result.denyMessage).toContain('denied by permission rules');
  });

  // The deny-only criterion in docs/design/safe-bash-comment-splitting.md is
  // pinned one layer below where production decides it: `evaluatePermissionRules`
  // calls `pm.evaluate()` only when `pm.hasRelevantRules()` is true, and the
  // comment fast path makes that false for a comment-bearing command, so the
  // shipped verdict is L3's `ShellToolInvocation.getDefaultPermission()`. It
  // gates substitution on the raw command but classifies
  // `stripShellWrapper(command)`, which for a wrapper shape discards the comment
  // too: `bash -c "ls" # ; rm -rf /tmp/x` strips to `ls`, read-only, so L3
  // returns `allow` where the merge base returned `deny` citing `Bash(rm *)`.
  // Not a bypass (Bash never executes the post-`#` text), but this layer
  // decides and `pm.evaluate` structurally cannot observe it. Reverting
  // `splitCommandForRules` to `splitCompoundCommand` restores `deny` and reds
  // this test.
  it('collapses a wrapper-shaped commented command to the L3 read-only allow under a deny rule', async () => {
    const command = 'bash -c "ls" # ; rm -rf /tmp/x';
    const pm = new PermissionManager({
      getPermissionsAllow: () => undefined,
      getPermissionsAsk: () => undefined,
      getPermissionsDeny: () => ['Bash(rm *)'],
    });
    pm.initialize();

    // What the design doc's criterion describes, and all this layer can see.
    expect(await pm.evaluate({ toolName: ToolNames.SHELL, command })).toBe(
      'ask',
    );

    const config = mockConfig({
      getPermissionManager: vi.fn().mockReturnValue(pm),
    });
    const result = await evaluatePermissionFlow(
      config,
      new ShellToolInvocation(config, { command, is_background: false }),
      ToolNames.SHELL,
      { command },
    );

    expect(result.defaultPermission).toBe('allow');
    expect(result.finalPermission).toBe('allow');
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

  const newPm = (deny: string[]) => {
    const pm = new PermissionManager({
      getPermissionsAllow: () => [],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => [...deny],
      getApprovalMode: () => ApprovalMode.DEFAULT,
    });
    pm.initialize();
    return pm;
  };

  const pmWithSkillGrant = () => {
    const pm = newPm([]);
    // Exactly what loading a skill whose SKILL.md lists
    // `allowedTools: [ask_user_question]` does to the session.
    applySkillAllowedTools(pm, [ToolNames.ASK_USER_QUESTION]);
    return pm;
  };

  // Runs the flow for a built ask_user_question invocation under `pm`.
  const flowForAsk = (interactive: boolean, pm: PermissionManager) => {
    const config = askConfig(interactive);
    const invocation = new AskUserQuestionTool(config).build({ questions });
    return evaluatePermissionFlow(
      { ...config, getPermissionManager: () => pm } as unknown as Config,
      invocation,
      ToolNames.ASK_USER_QUESTION,
      { questions },
    );
  };

  it("keeps the dialog when a skill's allowedTools grant would otherwise allow the tool", async () => {
    const pm = pmWithSkillGrant();
    const result = await flowForAsk(true, pm);

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
    const result = await flowForAsk(false, pmWithSkillGrant());

    expect(result.requiresUserInteraction).toBe(false);
    expect(result.finalPermission).toBe('allow');
  });

  it('preserves an explicit deny rule for ask_user_question', async () => {
    const pm = newPm([ToolNames.ASK_USER_QUESTION]);
    const result = await flowForAsk(true, pm);

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
  // isPlanModeBlocked(planMode, exitPlanTool, askUserTool, details(type), enterPlanTool).
  const blocked = (
    planMode: boolean,
    exitPlan: boolean,
    askUser: boolean,
    type: string,
    enterPlan?: boolean,
  ) =>
    isPlanModeBlocked(
      planMode,
      exitPlan,
      askUser,
      mockConfirmationDetails(type),
      enterPlan,
    );

  it('should block non-info tools in plan mode', () => {
    expect(blocked(true, false, false, 'exec')).toBe(true);

    expect(blocked(true, false, false, 'edit')).toBe(true);
  });

  it('should not block info-type tools in plan mode', () => {
    expect(blocked(true, false, false, 'info')).toBe(false);
  });

  it('should not block exit_plan_mode tool', () => {
    expect(blocked(true, true, false, 'exec')).toBe(false);
  });

  it('should not block ask_user_question tool', () => {
    expect(blocked(true, false, true, 'exec')).toBe(false);
  });

  it('should not block enter_plan_mode tool', () => {
    expect(blocked(true, false, false, 'exec', true)).toBe(false);
  });

  it('should not block when not in plan mode', () => {
    expect(blocked(false, false, false, 'exec')).toBe(false);
  });
});

describe('isAutoEditApproved', () => {
  const approved = (mode: ApprovalMode, type: string) =>
    isAutoEditApproved(mode, mockConfirmationDetails(type));

  it('should auto-approve edit-type tools in AUTO_EDIT mode', () => {
    expect(approved(ApprovalMode.AUTO_EDIT, 'edit')).toBe(true);
  });

  it('should auto-approve info-type tools in AUTO_EDIT mode', () => {
    expect(approved(ApprovalMode.AUTO_EDIT, 'info')).toBe(true);
  });

  it('should not auto-approve exec-type tools in AUTO_EDIT mode', () => {
    expect(approved(ApprovalMode.AUTO_EDIT, 'exec')).toBe(false);
  });

  it('should not auto-approve in non-AUTO_EDIT mode', () => {
    expect(approved(ApprovalMode.DEFAULT, 'edit')).toBe(false);
  });
});
