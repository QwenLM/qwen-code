/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolNames } from '../../tools/tool-names.js';
import { runWithTeammateIdentity } from '../team/identity.js';
import { runWithAgentContext } from './agent-context.js';
import {
  buildSubagentPlanToolBlockedResult,
  getSubagentPlanToolUnavailableMessage,
  isPlanRequiredTeammatePreApprovalAllowedTool,
  isPlanLifecycleToolUnavailableInSubagent,
  shouldUsePlanOnlyReminderInSubagentContext,
  isSubagentLikeExecutionContext,
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
      ['no tool config', undefined],
    ])(
      'withholds skills when an eager allowlist hides the Skill tool: %s',
      (_label, toolConfig) => {
        // `settings.tools.eager` omitting `skill` demotes it to
        // permission-deferred, and prepareTools() then drops it from the
        // declarations AND from exec's bindings — so no declaration shape
        // leaves a route to a skill.
        expect(
          toolConfigAllowsSkill(toolConfig, {
            codeModeOnly: true,
            skillEagerHidden: true,
          }),
        ).toBe(false);
      },
    );

    it('answers as before when the Skill tool is not eager-hidden', () => {
      // Control for the flag above: same input, flag absent.
      expect(
        toolConfigAllowsSkill(
          { tools: [ToolNames.EXEC] },
          { codeModeOnly: true, skillEagerHidden: false },
        ),
      ).toBe(true);
    });

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
});
