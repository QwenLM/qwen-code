/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode, type Config } from '../config/config.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';
import { ExitPlanModeTool, type ExitPlanModeParams } from './exitPlanMode.js';
import { ToolConfirmationOutcome } from './tools.js';

describe('ExitPlanModeTool', () => {
  let tool: ExitPlanModeTool;
  let config: Config;
  let approvalMode: ApprovalMode;
  let approvalModeRevision: number;
  let prePlanMode: ApprovalMode;
  let transitionError: Error | undefined;

  beforeEach(() => {
    approvalMode = ApprovalMode.PLAN;
    approvalModeRevision = 7;
    prePlanMode = ApprovalMode.DEFAULT;
    transitionError = undefined;
    config = {
      getApprovalMode: vi.fn(() => approvalMode),
      getApprovalModeRevision: vi.fn(() => approvalModeRevision),
      getPrePlanMode: vi.fn(() => prePlanMode),
      setApprovalMode: vi.fn((mode: ApprovalMode) => {
        if (transitionError) throw transitionError;
        if (approvalMode !== mode) approvalModeRevision++;
        approvalMode = mode;
      }),
      savePlan: vi.fn(),
      getTeamManager: vi.fn(() => undefined),
    } as unknown as Config;
    tool = new ExitPlanModeTool(config);
  });

  it('exposes the plan schema without the removed gate fields', () => {
    expect(tool.name).toBe('exit_plan_mode');
    expect(tool.kind).toBe('think');
    expect(tool.shouldDefer).toBe(true);
    expect(tool.alwaysLoad).toBe(true);
    expect(tool.schema.parametersJsonSchema).toMatchObject({
      properties: {
        plan: { type: 'string' },
        originalRequest: { type: 'string' },
        researchSummary: { type: 'string' },
      },
      required: ['plan'],
      additionalProperties: false,
    });
    expect(
      (tool.schema.parametersJsonSchema as { properties: object }).properties,
    ).not.toHaveProperty('resolutionSummary');
  });

  it.each([undefined, '', '  \n'])('rejects an empty plan (%j)', (plan) => {
    expect(
      tool.validateToolParams({ plan } as unknown as ExitPlanModeParams),
    ).toBe('Parameter "plan" must be a non-empty string.');
  });

  it('always requires explicit interaction in the main session', async () => {
    const invocation = tool.build({ plan: 'Plan' });

    expect(invocation.requiresUserInteraction?.()).toBe(true);
    await expect(invocation.getDefaultPermission()).resolves.toBe('ask');
  });

  it('denies outside plan mode without constructing a misleading prompt', async () => {
    approvalMode = ApprovalMode.DEFAULT;
    const invocation = tool.build({ plan: 'Plan' });

    await expect(invocation.getDefaultPermission()).resolves.toBe('deny');
    await expect(
      invocation.getConfirmationDetails(new AbortController().signal),
    ).rejects.toThrow('outside plan mode');
  });

  it.each([
    [ToolConfirmationOutcome.ProceedOnce, ApprovalMode.DEFAULT],
    [ToolConfirmationOutcome.ProceedAlways, ApprovalMode.AUTO_EDIT],
    [ToolConfirmationOutcome.RestorePrevious, ApprovalMode.YOLO],
  ])(
    'records %s and changes mode only during execute',
    async (outcome, targetMode) => {
      prePlanMode = ApprovalMode.YOLO;
      const invocation = tool.build({ plan: 'Approved plan' });
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      expect(confirmation).toMatchObject({
        type: 'plan',
        plan: 'Approved plan',
        prePlanMode: ApprovalMode.YOLO,
        hideAlwaysAllow: true,
      });
      await confirmation.onConfirm(outcome);
      expect(approvalMode).toBe(ApprovalMode.PLAN);
      expect(config.setApprovalMode).not.toHaveBeenCalled();

      const result = await invocation.execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(approvalMode).toBe(targetMode);
      expect(config.setApprovalMode).toHaveBeenCalledWith(targetMode);
      expect(config.savePlan).toHaveBeenCalledWith('Approved plan');
    },
  );

  it('freezes the plan and pre-plan mode when confirmation is created', async () => {
    const params = { plan: 'Original plan' };
    prePlanMode = ApprovalMode.YOLO;
    const invocation = tool.build(params);
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    params.plan = 'Mutated plan';
    prePlanMode = ApprovalMode.AUTO;

    await confirmation.onConfirm(ToolConfirmationOutcome.RestorePrevious);
    const result = await invocation.execute(new AbortController().signal);

    expect(result.returnDisplay).toMatchObject({ plan: 'Original plan' });
    expect(config.savePlan).toHaveBeenCalledWith('Original plan');
    expect(approvalMode).toBe(ApprovalMode.YOLO);
  });

  it('executes the snapshot belonging to the confirmation that was approved', async () => {
    const params = { plan: 'First plan' };
    const invocation = tool.build(params);
    const firstConfirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    params.plan = 'Second plan';
    await invocation.getConfirmationDetails(new AbortController().signal);

    await firstConfirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    const result = await invocation.execute(new AbortController().signal);

    expect(result.returnDisplay).toMatchObject({ plan: 'First plan' });
    expect(config.savePlan).toHaveBeenCalledWith('First plan');
  });

  it('keeps plan mode on cancellation', async () => {
    const invocation = tool.build({ plan: 'Plan' });
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );

    await confirmation.onConfirm(ToolConfirmationOutcome.Cancel);
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('not approved');
    expect(approvalMode).toBe(ApprovalMode.PLAN);
    expect(config.setApprovalMode).not.toHaveBeenCalled();
    expect(config.savePlan).not.toHaveBeenCalled();
  });

  it.each([
    ToolConfirmationOutcome.ProceedAlwaysProject,
    ToolConfirmationOutcome.ProceedAlwaysUser,
    ToolConfirmationOutcome.ModifyWithEditor,
  ])('fails closed for invalid plan outcome %s', async (outcome) => {
    const invocation = tool.build({ plan: 'Plan' });
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );

    await expect(confirmation.onConfirm(outcome)).rejects.toThrow(
      'Invalid plan approval outcome',
    );
    expect(approvalMode).toBe(ApprovalMode.PLAN);
    expect(config.setApprovalMode).not.toHaveBeenCalled();
  });

  it('keeps plan mode when aborted after approval', async () => {
    const controller = new AbortController();
    const invocation = tool.build({ plan: 'Plan' });
    const confirmation = await invocation.getConfirmationDetails(
      controller.signal,
    );
    await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    controller.abort();

    const result = await invocation.execute(controller.signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('cancelled');
    expect(approvalMode).toBe(ApprovalMode.PLAN);
    expect(config.setApprovalMode).not.toHaveBeenCalled();
  });

  it('rejects approval after leaving and re-entering plan mode', async () => {
    const invocation = tool.build({ plan: 'Plan' });
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    approvalMode = ApprovalMode.DEFAULT;
    approvalModeRevision++;
    approvalMode = ApprovalMode.PLAN;
    approvalModeRevision++;

    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('stale');
    expect(approvalMode).toBe(ApprovalMode.PLAN);
    expect(config.setApprovalMode).not.toHaveBeenCalled();
  });

  it('allows only the first of two concurrent approved exits', async () => {
    const first = tool.build({ plan: 'First' });
    const second = tool.build({ plan: 'Second' });
    const signal = new AbortController().signal;
    const [firstConfirmation, secondConfirmation] = await Promise.all([
      first.getConfirmationDetails(signal),
      second.getConfirmationDetails(signal),
    ]);
    await firstConfirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    await secondConfirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);

    const firstResult = await first.execute(signal);
    const secondResult = await second.execute(signal);

    expect(firstResult.error).toBeUndefined();
    expect(secondResult.error).toBeUndefined();
    expect(secondResult.llmContent).toContain('stale');
    expect(config.savePlan).toHaveBeenCalledTimes(1);
  });

  it('supports a config initialized directly in plan mode at revision zero', async () => {
    approvalModeRevision = 0;
    const invocation = tool.build({ plan: 'Initial plan' });
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);

    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(approvalMode).toBe(ApprovalMode.DEFAULT);
  });

  it('returns an error and stays in plan mode when transition fails', async () => {
    transitionError = new Error('mode locked');
    const invocation = tool.build({ plan: 'Plan' });
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);

    const result = await invocation.execute(new AbortController().signal);

    expect(result.error?.message).toContain('mode locked');
    expect(approvalMode).toBe(ApprovalMode.PLAN);
    expect(config.savePlan).toHaveBeenCalledWith('Plan');
  });

  it('treats plan persistence failure as advisory after a successful exit', async () => {
    vi.mocked(config.savePlan).mockImplementation(() => {
      throw new Error('disk full');
    });
    const invocation = tool.build({ plan: 'Plan' });
    const confirmation = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);

    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(approvalMode).toBe(ApprovalMode.DEFAULT);
  });

  it('retains the subagent lifecycle policy', async () => {
    const invocation = tool.build({ plan: 'Subagent plan' });

    await expect(
      runWithAgentContext('agent-1', async () =>
        invocation.requiresUserInteraction?.(),
      ),
    ).resolves.toBe(false);
    await expect(
      runWithAgentContext('agent-1', () => invocation.getDefaultPermission()),
    ).resolves.toBe('allow');

    const result = await runWithAgentContext('agent-1', () =>
      invocation.execute(new AbortController().signal),
    );

    expect(result.error?.message).toContain('not available inside subagents');
    expect(config.setApprovalMode).not.toHaveBeenCalled();
  });

  it('rechecks the revision after asynchronous teammate leader approval', async () => {
    let resolveDecision: ((value: object) => void) | undefined;
    const requestPlanApproval = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    vi.mocked(config.getTeamManager).mockReturnValue({
      requestPlanApproval,
    } as never);
    const invocation = tool.build({ plan: 'Teammate plan' });
    const execution = runWithTeammateIdentity(
      {
        agentId: 'planner@test',
        agentName: 'planner',
        teamName: 'test',
        isTeamLead: false,
        planModeRequired: true,
      },
      () => invocation.execute(new AbortController().signal),
    );
    approvalModeRevision++;
    resolveDecision?.({
      action: 'approve',
      targetMode: ApprovalMode.DEFAULT,
    });

    const result = await execution;

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('stale');
    expect(config.setApprovalMode).not.toHaveBeenCalled();
  });

  it('treats cancelled teammate approval as control flow', async () => {
    const controller = new AbortController();
    vi.mocked(config.getTeamManager).mockReturnValue({
      requestPlanApproval: vi.fn(async () => {
        controller.abort();
        return {
          action: 'approve',
          targetMode: ApprovalMode.DEFAULT,
        };
      }),
    } as never);
    const invocation = tool.build({ plan: 'Teammate plan' });

    const result = await runWithTeammateIdentity(
      {
        agentId: 'planner@test',
        agentName: 'planner',
        teamName: 'test',
        isTeamLead: false,
        planModeRequired: true,
      },
      () => invocation.execute(controller.signal),
    );

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('cancelled');
    expect(config.setApprovalMode).not.toHaveBeenCalled();
  });
});
