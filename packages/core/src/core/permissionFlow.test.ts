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

  it('frames a specifier-scoped deny as invocation-scoped, not tool-scoped', async () => {
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockResolvedValue('deny'),
      findMatchingDenyRule: vi.fn().mockReturnValue('Bash(npm view *)'),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
    };

    const invocation = mockInvocation({
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
    });

    const result = await evaluatePermissionFlow(
      mockConfig({ getPermissionManager: vi.fn().mockReturnValue(mockPm) }),
      invocation,
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
      const mockPm = {
        hasRelevantRules: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockResolvedValue('deny'),
        findMatchingDenyRule: vi.fn().mockReturnValue(raw),
        hasMatchingAskRule: vi.fn().mockReturnValue(false),
      };

      const result = await evaluatePermissionFlow(
        mockConfig({ getPermissionManager: vi.fn().mockReturnValue(mockPm) }),
        mockInvocation({
          getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        }),
        'shell',
        { command: 'echo hello' },
      );

      // The rule is still cited …
      expect(result.denyMessage).toContain(`Matching deny rule: "${raw}"`);
      // … but a fully-blocked tool must not be told it can try other uses.
      expect(result.denyMessage).not.toContain(
        'Other uses of this tool are still permitted',
      );
    }
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

  // A rule pinned to a derived value (the Workflow tool's script digest) must
  // be checked against the value the invocation computed, never a same-named
  // parameter the model supplied.
  it('matches rules against the parameters the invocation derives', async () => {
    const mockPm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockResolvedValue('allow'),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
    };
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

    await evaluatePermissionFlow(
      mockConfig({
        getPermissionManager: vi.fn().mockReturnValue(mockPm),
      }),
      invocation,
      ToolNames.WORKFLOW,
      modelParams,
    );

    // Derived after the L3 check, which is where the value is computed.
    expect(order).toEqual(['default', 'match']);
    expect(mockPm.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolParams: { name: 'audit', sha256: 'derived' },
      }),
    );
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

  // The deny-only criterion in docs/design/safe-bash-comment-splitting.md is
  // pinned one layer below where production decides it. `evaluatePermissionRules`
  // calls `pm.evaluate()` only when `pm.hasRelevantRules()` is true, and the
  // comment fast path makes that gate false for a comment-bearing command — so
  // the shipped verdict is L3's `ShellToolInvocation.getDefaultPermission()`.
  // That method gates substitution on the raw command but classifies
  // `stripShellWrapper(command)`, and for a wrapper shape the strip discards the
  // comment along with the wrapper: `bash -c "ls" # ; rm -rf /tmp/x` strips to
  // `ls`, the AST reads it as read-only, and L3 returns `allow` where the merge
  // base returned `deny` citing `Bash(rm *)`. Not a bypass — Bash never executes
  // the post-`#` text — but it is the layer that decides, and `pm.evaluate`
  // structurally cannot observe it. Reverting `splitCommandForRules` to
  // `splitCompoundCommand` restores `deny` and reds this test.
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

describe('pmForcedAsk with a real PermissionManager', () => {
  it('is true when an explicit ask rule matches a stripped heredoc payload', async () => {
    const realPm = new PermissionManager({
      getPermissionsAllow: () => ['Bash(cat *)', 'Bash(echo *)'],
      getPermissionsAsk: () => ['Bash(*rm -rf*)'],
      getPermissionsDeny: () => undefined,
      getCoreTools: () => undefined,
    } as never);
    realPm.initialize();

    const invocation = mockInvocation();
    const config = mockConfig({
      getPermissionManager: vi.fn().mockReturnValue(realPm),
    });

    const result = await evaluatePermissionFlow(
      config,
      invocation,
      'run_shell_command',
      {
        command:
          "cat <<'EOF'\nrm -rf /important is what this doc warns about\nEOF\necho done",
      },
    );

    expect(result.finalPermission).toBe('ask');
    expect(result.pmForcedAsk).toBe(true);
  });
});
