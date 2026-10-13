/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import type { ConfigParameters } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import type {
  ModPermission,
  ModToolCheck,
  ModToolCheckResult,
} from '../mods/tool-events.js';
import { InputFormat } from '../output/types.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import type { PermissionDecision } from '../permissions/types.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ExecTool } from '../tools/exec.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
  Kind,
  ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
} from '../tools/tools.js';
import {
  CoreToolScheduler,
  type CompletedToolCall,
  type ToolCall,
  type WaitingToolCall,
} from './coreToolScheduler.js';

function setup(
  modToolCheck?: ModToolCheck,
  options: {
    name?: string;
    permission?: PermissionDecision;
    interaction?: boolean;
    config?: Partial<ConfigParameters>;
    hookOutput?: (event: string) => Record<string, unknown>;
  } = {},
) {
  const config = makeFakeConfig({
    approvalMode: ApprovalMode.DEFAULT,
    chatRecording: false,
    targetDir: '/tmp',
    cwd: '/tmp',
    disableAllHooks: !options.hookOutput,
    ...options.config,
  });
  const execute = vi.fn(async () => ({
    llmContent: 'native result',
    returnDisplay: 'native result',
  }));
  const getConfirmationDetails = vi.fn(
    async (): Promise<ToolCallConfirmationDetails> => ({
      type: 'info',
      title: 'Confirm checked tool',
      prompt: 'Confirm checked tool',
      onConfirm: async () => {},
    }),
  );
  const tool = new MockTool({
    name: options.name ?? 'checked_tool',
    kind: Kind.Read,
    params: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    getDefaultPermission: async () => options.permission ?? 'allow',
    requiresUserInteraction: () => options.interaction ?? false,
    getConfirmationDetails,
    execute,
  });
  const registry = new ToolRegistry(config);
  registry.registerTool(tool);
  if (options.config?.codeModeOnly) {
    registry.registerTool(new ExecTool(config));
  }
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  const hookRequest = vi.fn(async ({ eventName }: { eventName: string }) => ({
    type: MessageBusType.HOOK_EXECUTION_RESPONSE,
    correlationId: eventName,
    success: true,
    output: options.hookOutput?.(eventName) ?? {},
  }));
  if (options.hookOutput) {
    config.setMessageBus({ request: hookRequest } as unknown as MessageBus);
  }
  const completed = vi.fn<(calls: CompletedToolCall[]) => void>();
  const updates: ToolCall[] = [];
  const scheduler = new CoreToolScheduler({
    config,
    modToolCheck,
    onAllToolCallsComplete: async (calls) => completed(calls),
    onToolCallsUpdate: (calls) => updates.push(...calls),
    getPreferredEditor: () => undefined,
    onEditorClose: () => {},
  });
  const schedule = (
    args: Record<string, unknown> = { value: 'original' },
    signal = new AbortController().signal,
    name = tool.name,
  ) =>
    scheduler.schedule(
      {
        callId: 'mod-checked-call',
        name,
        args,
        isClientInitiated: false,
        prompt_id: 'mod-tool-check',
      },
      signal,
    );
  const settled = async () => {
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    return completed.mock.calls[0][0][0];
  };
  const run = async (
    args?: Record<string, unknown>,
    signal?: AbortSignal,
    name?: string,
  ) => {
    await schedule(args, signal, name);
    return settled();
  };
  const waiting = () =>
    updates.findLast(
      (call): call is WaitingToolCall => call.status === 'awaiting_approval',
    );
  return {
    config,
    execute,
    getConfirmationDetails,
    hookRequest,
    run,
    schedule,
    settled,
    waiting,
  };
}

describe('headless-owned Mod tool.check restriction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the existing execution path when no Mod check is supplied', async () => {
    const harness = setup();
    expect((await harness.run()).status).toBe('success');
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it.each(
    (['allow', 'ask', 'deny'] as const).flatMap((host) =>
      (['allow', 'ask', 'deny'] as const).map((mod) => ({ host, mod })),
    ),
  )('only narrows host $host with Mod $mod', async ({ host, mod }) => {
    const check = vi.fn<ModToolCheck>(async () => ({
      decision: mod,
      reason: 'Mod decision',
    }));
    const harness = setup(check, { permission: host });
    const call = await harness.run();
    expect(check.mock.calls[0][1].decision).toBe(host);
    const allowed = host === 'allow' && mod === 'allow';
    expect(call.status).toBe(allowed ? 'success' : 'error');
    expect(harness.execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) {
      expect(call.response.executionStatus).toBe('not_started');
      expect(call.response.errorType).toBe(ToolErrorType.EXECUTION_DENIED);
    }
    if (host === 'deny') {
      expect(call.response.error?.message).toContain(
        "default permission is 'deny'",
      );
      expect(call.response.error?.message).not.toContain('Mod decision');
    }
  });

  it.each(['allow', 'ask'] as const)(
    'keeps YOLO host handling for a returned %s decision',
    async (decision) => {
      const check = vi.fn<ModToolCheck>(async () => ({ decision }));
      const harness = setup(check, {
        permission: 'ask',
        config: { approvalMode: ApprovalMode.YOLO },
      });
      expect((await harness.run()).status).toBe('success');
      expect(harness.getConfirmationDetails).not.toHaveBeenCalled();
    },
  );

  it('does not let Mod allow remove a required human interaction under YOLO', async () => {
    const harness = setup(async () => ({ decision: 'allow' }), {
      interaction: true,
      config: { approvalMode: ApprovalMode.YOLO },
    });
    const call = await harness.run();
    expect(call.response.approvalRequired).toBe(true);
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('keeps AUTO handling for an unchanged native ask', async () => {
    const check = vi.fn<ModToolCheck>(async (_input, verdict) => verdict);
    const harness = setup(check, {
      name: 'read_file',
      permission: 'ask',
      config: { approvalMode: ApprovalMode.AUTO },
    });
    vi.spyOn(harness.config.getLlmClient(), 'getHistoryTail').mockReturnValue(
      [],
    );
    vi.spyOn(
      harness.config.getLlmClient(),
      'getTrustedUserAnswers',
    ).mockReturnValue([]);
    const call = await harness.run();
    expect(call.status).toBe('success');
    expect(check.mock.calls[0][1]).toEqual({ decision: 'ask' });
    expect(harness.getConfirmationDetails).not.toHaveBeenCalled();
  });

  it('uses the existing stream-json confirmation for Mod ask', async () => {
    const harness = setup(async () => ({ decision: 'ask' }), {
      config: { inputFormat: InputFormat.STREAM_JSON },
    });
    await harness.schedule();
    expect(harness.execute).not.toHaveBeenCalled();
    const waiting = harness.waiting();
    expect(waiting).toBeDefined();
    await waiting!.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect((await harness.settled()).status).toBe('success');
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it('preserves PermissionManager forced ask when Mod returns allow', async () => {
    const harness = setup(async () => ({ decision: 'allow' }), {
      config: { inputFormat: InputFormat.STREAM_JSON },
    });
    const permissions = new PermissionManager(harness.config);
    permissions.addSessionAskRule('checked_tool');
    vi.spyOn(harness.config, 'getPermissionManager').mockReturnValue(
      permissions,
    );
    await harness.schedule();
    const waiting = harness.waiting();
    expect(waiting?.confirmationDetails).toMatchObject({
      hideAlwaysAllow: true,
    });
    expect(harness.execute).not.toHaveBeenCalled();
    await waiting!.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.Cancel,
    );
    expect((await harness.settled()).status).toBe('cancelled');
  });

  it('cannot enable a tool denied by PermissionManager', async () => {
    const check = vi.fn<ModToolCheck>(async () => ({ decision: 'allow' }));
    const harness = setup(check);
    const permissions = new PermissionManager(harness.config);
    permissions.addSessionDenyRule('checked_tool');
    vi.spyOn(harness.config, 'getPermissionManager').mockReturnValue(
      permissions,
    );
    const call = await harness.run();
    expect(call.response.errorType).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(check).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('checks cloned, validated input after a classic PreToolUse rewrite', async () => {
    const check = vi.fn<ModToolCheck>(async (input, verdict) => {
      expect(input).toEqual({
        tool: 'checked_tool',
        tool_use_id: 'mod-checked-call',
        input: { value: 'rewritten' },
      });
      (input.input as Record<string, unknown>)['value'] = 'tampered';
      return verdict;
    });
    const harness = setup(check, {
      hookOutput: (event) =>
        event === 'PreToolUse'
          ? { hookSpecificOutput: { updatedInput: { value: 'rewritten' } } }
          : {},
    });
    expect((await harness.run()).status).toBe('success');
    expect(check).toHaveBeenCalledOnce();
    expect(harness.execute).toHaveBeenCalledWith({ value: 'rewritten' });
  });

  it('rejects invalid native input before dispatching a Mod check', async () => {
    const check = vi.fn<ModToolCheck>(async (_input, verdict) => verdict);
    const harness = setup(check);
    const call = await harness.run({});
    expect(call.response.errorType).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    expect(check).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('keeps a classic PreToolUse ask mandatory under YOLO', async () => {
    const harness = setup(async () => ({ decision: 'allow' }), {
      config: {
        approvalMode: ApprovalMode.YOLO,
        inputFormat: InputFormat.STREAM_JSON,
      },
      hookOutput: (event) =>
        event === 'PreToolUse'
          ? {
              hookSpecificOutput: {
                permissionDecision: 'ask',
                permissionDecisionReason: 'Native hook confirmation',
              },
            }
          : {},
    });
    await harness.schedule();
    const waiting = harness.waiting();
    expect(waiting?.confirmationDetails).toMatchObject({
      hideAlwaysAllow: true,
    });
    expect(harness.execute).not.toHaveBeenCalled();
    await waiting!.confirmationDetails.onConfirm(
      ToolConfirmationOutcome.Cancel,
    );
    expect((await harness.settled()).status).toBe('cancelled');
  });

  it('checks PermissionRequest replacement input again before granting it', async () => {
    const check = vi.fn<ModToolCheck>(async (input) => ({
      decision:
        (input.input as Record<string, unknown>)['value'] === 'replacement'
          ? 'deny'
          : 'allow',
      reason: 'Replacement denied',
    }));
    const harness = setup(check, {
      permission: 'ask',
      config: { inputFormat: InputFormat.STREAM_JSON },
      hookOutput: (event) =>
        event === 'PermissionRequest'
          ? {
              hookSpecificOutput: {
                decision: {
                  behavior: 'allow',
                  updatedInput: { value: 'replacement' },
                },
              },
            }
          : {},
    });
    const call = await harness.run();
    expect(check.mock.calls.map(([input]) => input.input)).toEqual([
      { value: 'original' },
      { value: 'replacement' },
    ]);
    expect(call.response.error?.message).toBe('Replacement denied');
    expect(harness.execute).not.toHaveBeenCalled();
    expect(
      harness.hookRequest.mock.calls.filter(
        ([request]) => request.eventName === 'PermissionRequest',
      ),
    ).toHaveLength(1);
  });

  it('keeps the final host invocation guard authoritative', async () => {
    const harness = setup(async () => ({ decision: 'allow' }), {
      config: {
        toolInvocationGuard: () => ({ allowed: false, reason: 'Host denied' }),
      },
    });
    expect((await harness.run()).response.error?.message).toBe('Host denied');
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('does not execute when the check resolves after cancellation', async () => {
    const controller = new AbortController();
    const harness = setup(async () => {
      controller.abort();
      return { decision: 'allow' };
    });
    const call = await harness.run(undefined, controller.signal);
    expect(call.status).toBe('cancelled');
    expect(call.response.executionStatus).toBe('not_started');
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it.each(['throw', 'invalid'] as const)(
    'fails closed on a %s callback result',
    async (failure) => {
      const harness = setup(async () => {
        if (failure === 'throw') throw new Error('Host bridge failed');
        return { decision: 'invalid' as ModPermission };
      });
      const call = await harness.run();
      expect(call.status).toBe('error');
      expect(call.response.executionStatus).toBe('not_started');
      expect(harness.execute).not.toHaveBeenCalled();
    },
  );

  it('does not propagate the main-session callback to nested code-mode tools', async () => {
    const check = vi.fn<ModToolCheck>(
      async (input): Promise<ModToolCheckResult> => ({
        decision: input.tool === 'exec' ? 'allow' : 'deny',
      }),
    );
    const harness = setup(check, {
      config: { codeModeOnly: true, approvalMode: ApprovalMode.YOLO },
    });
    const call = await harness.run(
      { source: 'text(await tools.checked_tool({value: "nested"}));' },
      undefined,
      'exec',
    );
    expect(call.status).toBe('success');
    expect(harness.execute).toHaveBeenCalledWith({ value: 'nested' });
    expect(check.mock.calls.map(([input]) => input.tool)).toEqual(['exec']);
  });
});
