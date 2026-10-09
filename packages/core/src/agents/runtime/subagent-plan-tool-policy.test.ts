/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolNames } from '../../tools/tool-names.js';
import { ToolMode } from '../../tools/code-mode.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { ExecTool } from '../../tools/exec.js';
import { MockTool } from '../../test-utils/mock-tool.js';
import { runWithTeammateIdentity } from '../team/identity.js';
import { runWithAgentContext } from './agent-context.js';
import {
  buildSubagentPlanToolBlockedResult,
  getSubagentPlanToolUnavailableMessage,
  hasAgentSkillExecBinding,
  isAgentSkillEagerHidden,
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
      // An explicit empty list is the documented deny-all contract, so it
      // inherits nothing — no tools at all, and no skill tool.
      ['an empty list', { tools: [] }],
    ])('withholds skills for %s', (_label, toolConfig) => {
      expect(toolConfigAllowsSkill(toolConfig)).toBe(false);
    });

    it('credits the exec gateway only when its bindings are available', () => {
      const execList = { tools: [ToolNames.EXEC, ToolNames.READ_FILE] };
      expect(toolConfigAllowsSkill(execList, true)).toBe(true);
      expect(toolConfigAllowsSkill(execList, false)).toBe(false);
      expect(toolConfigAllowsSkill(execList)).toBe(false);
      expect(
        toolConfigAllowsSkill(
          { ...execList, disallowedTools: [ToolNames.SKILL] },
          true,
        ),
      ).toBe(false);
      expect(toolConfigAllowsSkill({ tools: [] }, true)).toBe(false);
    });

    it('honours the blocklist on the exec route itself', () => {
      // prepareTools() drops an exec the blocklist names, leaving no gateway;
      // the listing must not keep crediting the route through it.
      expect(
        toolConfigAllowsSkill(
          { tools: [ToolNames.EXEC], disallowedTools: [ToolNames.EXEC] },
          true,
        ),
      ).toBe(false);
      expect(
        toolConfigAllowsSkill(
          { tools: [ToolNames.EXEC], disallowedTools: [ToolNames.READ_FILE] },
          true,
        ),
      ).toBe(true);
    });
  });

  describe('hasAgentSkillExecBinding', () => {
    const contextWith = (mode: ToolMode, registerExec: boolean) => {
      const config = makeFakeConfig({ toolMode: mode });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      if (registerExec) {
        registry.registerTool(new ExecTool(config));
      }
      registry.registerTool(new MockTool({ name: ToolNames.SKILL }));
      return config;
    };

    it.each([ToolMode.CodeMode, ToolMode.CodeModeOnly])(
      'reports no exec route in %s when exec was never registered',
      (mode) => {
        // A deny rule or a legacy coreTools allowlist can keep exec out of
        // the registry entirely; the mode alone must not answer true.
        const context = contextWith(mode, false);
        expect(hasAgentSkillExecBinding(context)).toBe(false);
        expect(
          toolConfigAllowsSkill(
            { tools: [ToolNames.EXEC, ToolNames.READ_FILE] },
            hasAgentSkillExecBinding(context),
            isAgentSkillEagerHidden(context),
          ),
        ).toBe(false);
      },
    );

    it.each([ToolMode.CodeMode, ToolMode.CodeModeOnly])(
      'reports the exec route in %s while exec is registered',
      (mode) => {
        expect(hasAgentSkillExecBinding(contextWith(mode, true))).toBe(true);
      },
    );

    it('reports no exec route in Direct mode even with exec registered', () => {
      expect(hasAgentSkillExecBinding(contextWith(ToolMode.Direct, true))).toBe(
        false,
      );
    });
  });
});
