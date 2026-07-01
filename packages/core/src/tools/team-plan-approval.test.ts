/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode, type Config } from '../config/config.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';
import { TeamPlanApprovalTool } from './team-plan-approval.js';

describe('TeamPlanApprovalTool', () => {
  let approvalMode: ApprovalMode;
  let resolvePlanApprovalRequest: ReturnType<typeof vi.fn>;
  let config: Config;
  let tool: TeamPlanApprovalTool;

  beforeEach(() => {
    approvalMode = ApprovalMode.DEFAULT;
    resolvePlanApprovalRequest = vi.fn();
    config = {
      getApprovalMode: vi.fn(() => approvalMode),
      isTrustedFolder: vi.fn(() => true),
      getTeamManager: vi.fn(() => ({ resolvePlanApprovalRequest })),
    } as unknown as Config;
    tool = new TeamPlanApprovalTool(config);
  });

  it('approves a pending teammate plan using the leader current mode', async () => {
    approvalMode = ApprovalMode.AUTO_EDIT;
    const result = await tool
      .build({
        request_id: 'req-1',
        action: 'approve',
        message: 'Proceed.',
      })
      .execute(new AbortController().signal);

    expect(resolvePlanApprovalRequest).toHaveBeenCalledWith('req-1', {
      action: 'approve',
      targetMode: ApprovalMode.AUTO_EDIT,
      message: 'Proceed.',
    });
    expect(result.llmContent).toContain('approved');
  });

  it('downgrades approval target mode to default in untrusted workspaces', async () => {
    approvalMode = ApprovalMode.YOLO;
    vi.mocked(config.isTrustedFolder).mockReturnValue(false);

    await tool
      .build({ request_id: 'req-1', action: 'approve' })
      .execute(new AbortController().signal);

    expect(resolvePlanApprovalRequest).toHaveBeenCalledWith('req-1', {
      action: 'approve',
      targetMode: ApprovalMode.DEFAULT,
      message: undefined,
    });
  });

  it('downgrades auto approval target mode even in trusted workspaces', async () => {
    approvalMode = ApprovalMode.AUTO;

    await tool
      .build({ request_id: 'req-1', action: 'approve' })
      .execute(new AbortController().signal);

    expect(resolvePlanApprovalRequest).toHaveBeenCalledWith('req-1', {
      action: 'approve',
      targetMode: ApprovalMode.DEFAULT,
      message: undefined,
    });
  });

  it('does not settle the request when the leader is still in plan mode', async () => {
    approvalMode = ApprovalMode.PLAN;

    const result = await tool
      .build({ request_id: 'req-1', action: 'approve' })
      .execute(new AbortController().signal);

    expect(resolvePlanApprovalRequest).not.toHaveBeenCalled();
    expect(result.error?.message).toContain('leader is still in plan mode');
  });

  it('rejects a pending teammate plan without a target mode', async () => {
    const result = await tool
      .build({
        request_id: 'req-1',
        action: 'reject',
        message: 'Add rollback details.',
      })
      .execute(new AbortController().signal);

    expect(resolvePlanApprovalRequest).toHaveBeenCalledWith('req-1', {
      action: 'reject',
      message: 'Add rollback details.',
    });
    expect(result.llmContent).toContain('rejected');
  });

  it('is unavailable to teammates at runtime', async () => {
    const result = await runWithTeammateIdentity(
      {
        agentId: 'planner@test',
        agentName: 'planner',
        teamName: 'test',
        isTeamLead: false,
      },
      () =>
        tool
          .build({ request_id: 'req-1', action: 'approve' })
          .execute(new AbortController().signal),
    );

    expect(resolvePlanApprovalRequest).not.toHaveBeenCalled();
    expect(result.error?.message).toContain('Only the team leader');
  });

  it('is unavailable to subagents at runtime', async () => {
    const result = await runWithAgentContext('child-agent', () =>
      tool
        .build({ request_id: 'req-1', action: 'approve' })
        .execute(new AbortController().signal),
    );

    expect(resolvePlanApprovalRequest).not.toHaveBeenCalled();
    expect(result.error?.message).toContain('Only the team leader');
  });
});
