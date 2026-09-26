/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolNames } from '../../tools/tool-names.js';
import { ToolMode } from '../../tools/code-mode.js';
import type { Config } from '../../config/config.js';
import type { ToolRegistrationStatus } from '../../permissions/permission-manager.js';
import { runWithTeammateIdentity } from '../team/identity.js';
import { runWithAgentContext } from './agent-context.js';
import {
  buildSubagentPlanToolBlockedResult,
  getSubagentPlanToolUnavailableMessage,
  isPlanRequiredTeammatePreApprovalAllowedTool,
  isPlanLifecycleToolUnavailableInSubagent,
  shouldUsePlanOnlyReminderInSubagentContext,
  isSubagentLikeExecutionContext,
  skillRegistrationStatusFor,
  SUBAGENT_PLAN_LIFECYCLE_TOOLS,
  toolConfigAllowsSkill,
} from './subagent-plan-tool-policy.js';

describe('subagent plan tool policy', () => {
  it('recognizes subagent and teammate execution contexts', async () => {
    expect(isSubagentLikeExecutionContext()).toBe(false);

    await runWithAgentContext('agent-1', async () => {
      expect(isSubagentLikeExecutionContext()).toBe(true);
    });

    runWithTeammateIdentity(
      {
        agentId: 'agent@test',
        agentName: 'agent',
        teamName: 'test',
        isTeamLead: false,
      },
      () => {
        expect(isSubagentLikeExecutionContext()).toBe(true);
      },
    );
  });

  it('blocks only plan lifecycle tools inside subagent-like contexts', async () => {
    expect(SUBAGENT_PLAN_LIFECYCLE_TOOLS.has(ToolNames.ENTER_PLAN_MODE)).toBe(
      true,
    );
    expect(SUBAGENT_PLAN_LIFECYCLE_TOOLS.has(ToolNames.EXIT_PLAN_MODE)).toBe(
      true,
    );
    expect(
      isPlanLifecycleToolUnavailableInSubagent(ToolNames.ENTER_PLAN_MODE),
    ).toBe(false);

    await runWithAgentContext('agent-1', async () => {
      expect(
        isPlanLifecycleToolUnavailableInSubagent(ToolNames.ENTER_PLAN_MODE),
      ).toBe(true);
      expect(
        isPlanLifecycleToolUnavailableInSubagent(ToolNames.EXIT_PLAN_MODE),
      ).toBe(true);
      expect(
        isPlanLifecycleToolUnavailableInSubagent(ToolNames.READ_FILE),
      ).toBe(false);
    });
  });

  it('allows only exit_plan_mode for plan-required teammates', () => {
    runWithTeammateIdentity(
      {
        agentId: 'planner@test',
        agentName: 'planner',
        teamName: 'test',
        isTeamLead: false,
        planModeRequired: true,
      },
      () => {
        expect(
          isPlanLifecycleToolUnavailableInSubagent(ToolNames.ENTER_PLAN_MODE),
        ).toBe(true);
        expect(
          isPlanLifecycleToolUnavailableInSubagent(ToolNames.EXIT_PLAN_MODE),
        ).toBe(false);
        expect(shouldUsePlanOnlyReminderInSubagentContext()).toBe(false);
      },
    );
  });

  it('keeps plan-only reminders for ordinary teammates and subagents', async () => {
    runWithTeammateIdentity(
      {
        agentId: 'worker@test',
        agentName: 'worker',
        teamName: 'test',
        isTeamLead: false,
      },
      () => {
        expect(shouldUsePlanOnlyReminderInSubagentContext()).toBe(true);
      },
    );

    await runWithAgentContext('agent-1', async () => {
      expect(shouldUsePlanOnlyReminderInSubagentContext()).toBe(true);
    });
  });

  it('allows only claim-shaped task updates before leader approval', () => {
    runWithTeammateIdentity(
      {
        agentId: 'planner@test',
        agentName: 'planner',
        teamName: 'test',
        isTeamLead: false,
        planModeRequired: true,
      },
      () => {
        const taskUpdateCases: Array<{
          params: unknown;
          expected: boolean;
        }> = [
          {
            params: {
              taskId: 'TASK-1',
              status: 'in_progress',
              owner: 'planner',
            },
            expected: true,
          },
          { params: { status: 'in_progress' }, expected: false },
          {
            params: {
              taskId: 'TASK-1',
              status: 'in_progress',
              owner: 'worker',
            },
            expected: false,
          },
          {
            params: { taskId: 'TASK-1', status: 'completed' },
            expected: false,
          },
          {
            params: {
              taskId: 'TASK-1',
              status: 'in_progress',
              newContent: [],
            },
            expected: false,
          },
          {
            params: {
              taskId: 'TASK-1',
              status: 'in_progress',
              oldContent: [],
            },
            expected: false,
          },
          {
            params: {
              taskId: 'TASK-1',
              status: 'in_progress',
              addBlocks: ['TASK-2'],
            },
            expected: false,
          },
          {
            params: {
              taskId: 'TASK-1',
              status: 'in_progress',
              addBlockedBy: ['TASK-2'],
            },
            expected: false,
          },
          { params: null, expected: false },
        ];

        for (const { params, expected } of taskUpdateCases) {
          expect(
            isPlanRequiredTeammatePreApprovalAllowedTool(
              ToolNames.TASK_UPDATE,
              params,
            ),
          ).toBe(expected);
        }
        expect(
          isPlanRequiredTeammatePreApprovalAllowedTool(ToolNames.READ_FILE, {
            taskId: 'TASK-1',
            status: 'in_progress',
          }),
        ).toBe(true);
        expect(
          isPlanRequiredTeammatePreApprovalAllowedTool(ToolNames.SEND_MESSAGE, {
            taskId: 'TASK-1',
            status: 'in_progress',
          }),
        ).toBe(false);
      },
    );
  });

  it('builds a logged blocked result with caller guidance', () => {
    const logger = { warn: vi.fn() };

    const result = buildSubagentPlanToolBlockedResult(
      ToolNames.EXIT_PLAN_MODE,
      'ExitPlanModeTool',
      logger,
    );

    const message = getSubagentPlanToolUnavailableMessage(
      ToolNames.EXIT_PLAN_MODE,
    );
    expect(result).toEqual({
      llmContent: message,
      returnDisplay: message,
      error: { message },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      `[ExitPlanModeTool] Blocked plan lifecycle tool call from subagent: ${ToolNames.EXIT_PLAN_MODE}`,
    );
  });

  describe('toolConfigAllowsSkill', () => {
    it.each([
      ['no tool config', undefined],
      ['a wildcard', { tools: ['*'] }],
      ['an empty list', { tools: [] }],
      ['an explicit list naming skill', { tools: [ToolNames.SKILL] }],
      [
        'a blocklist that leaves skill alone',
        { tools: ['*'], disallowedTools: [ToolNames.SHELL] },
      ],
    ])('allows skills for %s', (_label, toolConfig) => {
      expect(toolConfigAllowsSkill(toolConfig)).toBe(true);
    });

    it.each([
      ['an explicit list without skill', { tools: [ToolNames.READ_FILE] }],
      [
        'a wildcard with skill disallowed',
        { tools: ['*'], disallowedTools: [ToolNames.SKILL] },
      ],
      [
        'an explicit list naming skill and disallowing it',
        { tools: [ToolNames.SKILL], disallowedTools: [ToolNames.SKILL] },
      ],
      // prepareTools declares exactly the inline entries here; nothing is
      // inherited from the registry.
      ['an inline-only declaration set', { tools: [{ name: 'custom' }] }],
    ])('withholds skills for %s', (_label, toolConfig) => {
      expect(toolConfigAllowsSkill(toolConfig)).toBe(false);
    });

    it('reaches skill through exec only under CodeModeOnly', () => {
      const execOnly = { tools: [ToolNames.EXEC] };
      expect(toolConfigAllowsSkill(execOnly, { codeModeOnly: true })).toBe(
        true,
      );
      expect(toolConfigAllowsSkill(execOnly)).toBe(false);
    });

    it.each([
      ['the exec route under CodeModeOnly', { tools: [ToolNames.EXEC] }],
      ['a wildcard', { tools: ['*'] }],
      ['an explicit list naming skill', { tools: [ToolNames.SKILL] }],
      [
        'an explicit list naming both bridge halves',
        { tools: [ToolNames.TOOL_SEARCH, ToolNames.TOOL_CALL] },
      ],
      ['no tool config', undefined],
    ])(
      'withholds skills when an eager allowlist hides the Skill tool: %s',
      (_label, toolConfig) => {
        // `settings.tools.eager` omitting `skill` demotes it to
        // permission-deferred, and prepareTools() then drops it from the
        // declarations AND from exec's bindings. CodeModeOnly also hides the
        // tool_search + tool_call bridge, so no declaration shape leaves a
        // route to a skill.
        expect(
          toolConfigAllowsSkill(toolConfig, {
            codeModeOnly: true,
            skillRegistration: 'deferred',
          }),
        ).toBe(false);
      },
    );

    it('answers as before when the Skill tool is not eager-hidden', () => {
      // Control for the flag above: same input, flag absent.
      expect(
        toolConfigAllowsSkill(
          { tools: [ToolNames.EXEC] },
          { codeModeOnly: true, skillRegistration: 'registered' },
        ),
      ).toBe(true);
    });

    // #12424: outside CodeModeOnly the bridge stays declared for an agent
    // that inherits the registry, so a deferred Skill tool is still
    // reachable there — but ONLY there. An explicit list that named neither
    // half declares no route, and the Agent tool's description would point
    // at two tools prepareTools() never declared. An explicit list is also
    // the invocation allowlist, so both halves on their own are not enough:
    // `skill` must survive that list too, or the scheduler re-gates the
    // resolved bridge target and refuses it (withholds matrix below).
    it.each([
      ['a wildcard', { tools: ['*'] }],
      ['an empty list', { tools: [] }],
      ['no tool config', undefined],
      [
        'an explicit list naming both bridge halves and skill',
        {
          tools: [
            ToolNames.READ_FILE,
            ToolNames.TOOL_SEARCH,
            ToolNames.TOOL_CALL,
            ToolNames.SKILL,
          ],
        },
      ],
      [
        "a fork's declaration snapshot naming both bridge halves",
        {
          tools: [
            ToolNames.READ_FILE,
            ToolNames.TOOL_SEARCH,
            ToolNames.TOOL_CALL,
          ],
          // A fork's `tools` is a declaration snapshot, not the invocation
          // allowlist: `getConfiguredToolExecutionAllowlist()` returns
          // undefined once `executionAllowedTools` is present, so the bridge
          // target is gated by that list instead and the finite `tools` no
          // longer has to name `skill`.
          executionAllowedTools: [ToolNames.READ_FILE, ToolNames.SKILL],
        },
      ],
    ])(
      'keeps skills for a Direct-mode agent whose declarations include the bridge: %s',
      (_label, toolConfig) => {
        expect(
          toolConfigAllowsSkill(toolConfig, { skillRegistration: 'deferred' }),
        ).toBe(true);
      },
    );

    it.each([
      [
        'an explicit list naming skill',
        { tools: [ToolNames.READ_FILE, ToolNames.SKILL] },
      ],
      ['an explicit list without skill', { tools: [ToolNames.READ_FILE] }],
      [
        'an explicit list naming only tool_search',
        { tools: [ToolNames.TOOL_SEARCH] },
      ],
      [
        'an explicit list naming both bridge halves but not skill',
        {
          tools: [
            ToolNames.READ_FILE,
            ToolNames.TOOL_SEARCH,
            ToolNames.TOOL_CALL,
          ],
        },
      ],
      [
        'a wildcard that disallows tool_search',
        { tools: ['*'], disallowedTools: [ToolNames.TOOL_SEARCH] },
      ],
      [
        'a wildcard that disallows tool_call',
        { tools: ['*'], disallowedTools: [ToolNames.TOOL_CALL] },
      ],
    ])(
      'withholds skills from a Direct-mode agent whose declarations leave no usable bridge: %s',
      (_label, toolConfig) => {
        expect(
          toolConfigAllowsSkill(toolConfig, { skillRegistration: 'deferred' }),
        ).toBe(false);
      },
    );

    it.each([
      ['a wildcard', { tools: ['*'] }],
      ['an explicit list naming skill', { tools: [ToolNames.SKILL] }],
      [
        'an explicit list naming both bridge halves',
        { tools: [ToolNames.TOOL_SEARCH, ToolNames.TOOL_CALL] },
      ],
      ['the exec route under CodeModeOnly', { tools: [ToolNames.EXEC] }],
      ['no tool config', undefined],
    ])(
      'withholds skills when a deny rule unregisters the Skill tool: %s',
      (_label, toolConfig) => {
        // `permissions.deny: ["skill"]` / `excludeTools` answer 'disabled':
        // registerLazyTool registers nothing for it, so the name exists in no
        // registry and no bridge can surface it — in either mode, and for
        // every declaration shape.
        expect(
          toolConfigAllowsSkill(toolConfig, {
            skillRegistration: 'disabled',
          }),
        ).toBe(false);
        expect(
          toolConfigAllowsSkill(toolConfig, {
            codeModeOnly: true,
            skillRegistration: 'disabled',
          }),
        ).toBe(false);
      },
    );

    it.each([
      ['a wildcard', { tools: ['*'] }],
      ['an exec-only list', { tools: [ToolNames.EXEC] }],
      [
        'an explicit list naming skill',
        { tools: [ToolNames.READ_FILE, ToolNames.SKILL] },
      ],
    ])(
      'withholds skills under CodeModeOnly when exec itself is disallowed: %s',
      (_label, toolConfig) => {
        // exec is the only route to a code-mode-callable tool, so denying it
        // leaves prepareTools() declaring nothing at all — including for an
        // agent that inherits the registry or names `skill` outright.
        expect(
          toolConfigAllowsSkill(
            { ...toolConfig, disallowedTools: [ToolNames.EXEC] },
            { codeModeOnly: true },
          ),
        ).toBe(false);
      },
    );

    it('keeps skills for a disallowed exec outside CodeModeOnly', () => {
      // Only under CodeModeOnly is exec the sole route; elsewhere the Skill
      // tool keeps its own declaration.
      expect(
        toolConfigAllowsSkill({
          tools: ['*'],
          disallowedTools: [ToolNames.EXEC],
        }),
      ).toBe(true);
    });

    it('ignores the execution allowlist', () => {
      // A fork's `fork_tools` narrowing; see the predicate's docblock.
      expect(
        toolConfigAllowsSkill({
          tools: ['*'],
          executionAllowedTools: [ToolNames.READ_FILE],
        }),
      ).toBe(true);
    });
  });

  describe('skillRegistrationStatusFor', () => {
    const configWith = (
      status: ToolRegistrationStatus | undefined,
      visible: string[] = [],
      toolMode: ToolMode = ToolMode.Direct,
    ): Config =>
      ({
        getPermissionManager: () =>
          status === undefined
            ? undefined
            : {
                getToolRegistrationStatus: async (name: string) =>
                  name === ToolNames.SKILL ? status : 'registered',
              },
        getVisibleTools: () => new Set(visible),
        getToolMode: () => toolMode,
      }) as unknown as Config;

    it('reports a denied Skill tool in both modes', async () => {
      // 'disabled' is answered before the tool mode and before tools.visible:
      // a deny rule never registers the tool, so no mode and no visibility
      // entry can bring a route back.
      for (const toolMode of [ToolMode.Direct, ToolMode.CodeModeOnly]) {
        await expect(
          skillRegistrationStatusFor(
            configWith('disabled', [ToolNames.SKILL], toolMode),
          ),
        ).resolves.toBe('disabled');
      }
    });

    it('reports a deferred Skill tool in both modes', async () => {
      // Whether a deferred tool is still reachable is the predicate's
      // question, not this probe's: answering 'registered' for every
      // Direct-mode session is what let an agent whose declarations named no
      // bridge half keep its SkillManager and its lit listing (#12424).
      for (const toolMode of [ToolMode.Direct, ToolMode.CodeModeOnly]) {
        await expect(
          skillRegistrationStatusFor(configWith('deferred', [], toolMode)),
        ).resolves.toBe('deferred');
      }
    });

    it('reads a tools.visible entry as re-exposing a deferred schema', async () => {
      await expect(
        skillRegistrationStatusFor(configWith('deferred', [ToolNames.SKILL])),
      ).resolves.toBe('registered');
    });

    it('falls back to registered where it cannot tell', async () => {
      await expect(
        skillRegistrationStatusFor(configWith(undefined)),
      ).resolves.toBe('registered');
      await expect(
        skillRegistrationStatusFor({} as unknown as Config),
      ).resolves.toBe('registered');
    });
  });
});
