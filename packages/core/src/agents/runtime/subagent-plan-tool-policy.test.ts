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
});
