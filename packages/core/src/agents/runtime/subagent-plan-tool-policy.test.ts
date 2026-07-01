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
  isPlanLifecycleToolUnavailableInSubagent,
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
