/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  InputFormat,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import { createMinimalSettings } from '../../../config/settings.js';
import type { StreamJsonOutputAdapter } from '../../io/StreamJsonOutputAdapter.js';
import type { IControlContext } from '../ControlContext.js';
import type { IPendingRequestRegistry } from './baseController.js';
import { PermissionController } from './permissionController.js';

function createContext(canUseToolTimeoutMs?: number): IControlContext {
  const abortController = new AbortController();

  return {
    config: {
      getDebugMode: vi.fn().mockReturnValue(false),
      getInputFormat: vi.fn().mockReturnValue(InputFormat.STREAM_JSON),
    } as unknown as IControlContext['config'],
    streamJson: {
      send: vi.fn(),
    } as unknown as StreamJsonOutputAdapter,
    sessionId: 'test-session-id',
    abortSignal: abortController.signal,
    debugMode: false,
    settings: createMinimalSettings(),
    permissionMode: 'default',
    sdkCanUseToolTimeoutMs: canUseToolTimeoutMs,
    sdkMcpServers: new Set<string>(),
    mcpClients: new Map(),
    inputClosed: false,
  };
}

function createRegistry(): IPendingRequestRegistry {
  return {
    registerIncomingRequest: vi.fn(),
    deregisterIncomingRequest: vi.fn(),
    registerOutgoingRequest: vi.fn(),
    deregisterOutgoingRequest: vi.fn(),
  };
}

describe('PermissionController', () => {
  it('treats stream-json can_use_tool allow as explicit interaction without replacing the plan', async () => {
    const context = createContext();
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    vi.spyOn(controller, 'sendControlRequest').mockResolvedValue({
      subtype: 'success',
      request_id: 'request-plan',
      response: {
        behavior: 'allow',
        updatedInput: { plan: 'Host-replaced plan' },
      },
    });
    const onConfirm = vi.fn();
    const request = {
      callId: 'tool-call-plan',
      name: 'exit_plan_mode',
      args: { plan: 'Approved plan' },
    };

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request,
        invocation: {
          requiresUserInteraction: () => true,
        },
        confirmationDetails: {
          type: 'plan',
          title: 'Approve plan',
          plan: 'Approved plan',
          onConfirm,
        },
      } as never,
    ]);

    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
      );
    });
    expect(request.args).toEqual({ plan: 'Approved plan' });
  });

  it('fails closed without an interactive SDK even in yolo mode', async () => {
    const context = createContext();
    vi.mocked(context.config.getInputFormat).mockReturnValue('text');
    context.permissionMode = 'yolo';
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    const onConfirm = vi.fn();

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request: {
          callId: 'tool-call-plan-no-sdk',
          name: 'exit_plan_mode',
          args: { plan: 'Plan' },
        },
        invocation: {
          requiresUserInteraction: () => true,
        },
        confirmationDetails: {
          type: 'plan',
          title: 'Approve plan',
          plan: 'Plan',
          onConfirm,
        },
      } as never,
    ]);

    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
        expect.objectContaining({
          cancelMessage: expect.stringContaining('mode selector'),
        }),
      );
    });
  });

  it('uses SDK canUseTool timeout for outgoing permission requests', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    const sendControlRequest = vi
      .spyOn(controller, 'sendControlRequest')
      .mockResolvedValue({
        subtype: 'success',
        request_id: 'request-1',
        response: { behavior: 'allow' },
      });
    const onConfirm = vi.fn();

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request: {
          callId: 'tool-call-1',
          name: 'ask_user_question',
          args: { questions: [] },
        },
        confirmationDetails: {
          type: 'ask_user_question',
          title: 'Please answer',
          onConfirm,
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(sendControlRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'can_use_tool',
          tool_name: 'ask_user_question',
        }),
        120_000,
        context.abortSignal,
      );
    });
    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
      );
    });
  });

  it('routes ask_user_question answers from updatedInput into the confirmation payload', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    const answers = { '0': 'PostgreSQL', '1': 'REST' };
    vi.spyOn(controller, 'sendControlRequest').mockResolvedValue({
      subtype: 'success',
      request_id: 'request-answers',
      response: {
        behavior: 'allow',
        updatedInput: { questions: [], answers },
      },
    });
    const onConfirm = vi.fn();
    const toolCall = {
      status: 'awaiting_approval',
      request: {
        callId: 'tool-call-answers',
        name: 'ask_user_question',
        args: { questions: [] } as Record<string, unknown>,
      },
      confirmationDetails: {
        type: 'ask_user_question',
        title: 'Please answer',
        onConfirm,
      },
    };

    controller.getToolCallUpdateCallback()([toolCall]);

    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        expect.objectContaining({ answers }),
      );
    });

    // The leader path overrides the tool's in-process args with the
    // host's sanitized updatedInput before confirming.
    expect(toolCall.request.args).toEqual({ questions: [], answers });
  });

  it('omits answers from the payload when updatedInput has none', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    vi.spyOn(controller, 'sendControlRequest').mockResolvedValue({
      subtype: 'success',
      request_id: 'request-no-answers',
      response: {
        behavior: 'allow',
        updatedInput: { command: 'ls -a' },
      },
    });
    const onConfirm = vi.fn();

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request: {
          callId: 'tool-call-no-answers',
          name: 'run_shell_command',
          args: { command: 'ls' },
        },
        confirmationDetails: {
          type: 'exec',
          title: 'Run command',
          onConfirm,
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { updatedInput: { command: 'ls -a' } },
      );
    });
  });

  it('does not promote a same-named answers field for non-ask_user_question tools', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    vi.spyOn(controller, 'sendControlRequest').mockResolvedValue({
      subtype: 'success',
      request_id: 'request-foreign-answers',
      response: {
        behavior: 'allow',
        // A non-ask_user_question tool happens to carry an `answers` field;
        // it must not leak into the confirmation payload.
        updatedInput: { command: 'ls', answers: { '0': 'leak' } },
      },
    });
    const onConfirm = vi.fn();

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request: {
          callId: 'tool-call-foreign-answers',
          name: 'run_shell_command',
          args: { command: 'ls' },
        },
        confirmationDetails: {
          type: 'exec',
          title: 'Run command',
          onConfirm,
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { updatedInput: { command: 'ls', answers: { '0': 'leak' } } },
      );
    });
    expect(onConfirm).not.toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      expect.objectContaining({ answers: expect.anything() }),
    );
  });

  it.each([
    ['updatedInput is an array', ['ls'], undefined],
    ['updatedInput is a string', 'ls', undefined],
    ['answers is an array', { questions: [], answers: ['x'] }, undefined],
    ['answers is null', { questions: [], answers: null }, undefined],
    ['answers is an empty object', { questions: [], answers: {} }, {}],
  ])(
    'omits answers from the payload when %s',
    async (_desc, updatedInput, expectedAnswers) => {
      const context = createContext(120_000);
      const controller = new PermissionController(
        context,
        createRegistry(),
        'PermissionController',
      );
      vi.spyOn(controller, 'sendControlRequest').mockResolvedValue({
        subtype: 'success',
        request_id: 'request-guard',
        response: { behavior: 'allow', updatedInput },
      });
      const onConfirm = vi.fn();

      controller.getToolCallUpdateCallback()([
        {
          status: 'awaiting_approval',
          request: {
            callId: 'tool-call-guard',
            name: 'ask_user_question',
            args: { questions: [] },
          },
          confirmationDetails: {
            type: 'ask_user_question',
            title: 'Please answer',
            onConfirm,
          },
        },
      ]);

      await vi.waitFor(() => {
        expect(onConfirm).toHaveBeenCalled();
      });

      const [outcome, payload] = onConfirm.mock.calls[0];
      expect(outcome).toBe(ToolConfirmationOutcome.ProceedOnce);
      const isPlainObject =
        updatedInput !== null &&
        typeof updatedInput === 'object' &&
        !Array.isArray(updatedInput);
      if (!isPlainObject) {
        // A non-object updatedInput (array or primitive) is rejected
        // wholesale — plain confirm, no payload.
        expect(payload).toBeUndefined();
      } else if (expectedAnswers === undefined) {
        expect(payload).toEqual({ updatedInput });
        expect(payload).not.toHaveProperty('answers');
      } else {
        expect(payload).toEqual({ updatedInput, answers: expectedAnswers });
      }
    },
  );

  it('uses default timeout when SDK canUseTool timeout is undefined', async () => {
    const context = createContext(); // undefined timeout
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    const sendControlRequest = vi
      .spyOn(controller, 'sendControlRequest')
      .mockResolvedValue({
        subtype: 'success',
        request_id: 'request-2',
        response: { behavior: 'allow' },
      });
    const onConfirm = vi.fn();

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request: {
          callId: 'tool-call-2',
          name: 'ask_user_question',
          args: { questions: [] },
        },
        confirmationDetails: {
          type: 'ask_user_question',
          title: 'Please answer',
          onConfirm,
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(sendControlRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'can_use_tool',
          tool_name: 'ask_user_question',
        }),
        60_000, // DEFAULT_CAN_USE_TOOL_TIMEOUT_MS
        context.abortSignal,
      );
    });
    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
      );
    });
  });

  it('calls onConfirm with Cancel when sendControlRequest rejects', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    vi.spyOn(controller, 'sendControlRequest').mockRejectedValue(
      new Error('Request timeout'),
    );
    const onConfirm = vi.fn();

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request: {
          callId: 'tool-call-3',
          name: 'ask_user_question',
          args: { questions: [] },
        },
        confirmationDetails: {
          type: 'ask_user_question',
          title: 'Please answer',
          onConfirm,
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
        expect.objectContaining({
          cancelMessage: expect.stringContaining('Request timeout'),
        }),
      );
    });
  });

  it('forwards ask_user_question answers to a teammate approval', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    const answers = { '0': 'PostgreSQL', '1': 'REST' };
    vi.spyOn(controller, 'sendControlRequest').mockResolvedValue({
      subtype: 'success',
      request_id: 'teammate-request',
      response: {
        behavior: 'allow',
        updatedInput: { questions: [], answers },
      },
    });
    const respond = vi.fn().mockResolvedValue(undefined);

    await controller.handleTeammateApproval({
      teammateName: 'worker',
      toolName: 'ask_user_question',
      toolInput: { questions: [] },
      respond,
      timestamp: 123,
    });

    expect(respond).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      expect.objectContaining({ answers }),
    );
  });

  it('does not promote a same-named answers field for a non-ask_user_question teammate approval', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    vi.spyOn(controller, 'sendControlRequest').mockResolvedValue({
      subtype: 'success',
      request_id: 'teammate-request-foreign',
      response: {
        behavior: 'allow',
        updatedInput: { command: 'ls', answers: { '0': 'leak' } },
      },
    });
    const respond = vi.fn().mockResolvedValue(undefined);

    await controller.handleTeammateApproval({
      teammateName: 'worker',
      toolName: 'run_shell_command',
      toolInput: { command: 'ls' },
      respond,
      timestamp: 456,
    });

    expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.ProceedOnce, {
      updatedInput: { command: 'ls', answers: { '0': 'leak' } },
    });
    expect(respond).not.toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      expect.objectContaining({ answers: expect.anything() }),
    );
  });

  it('confirms a teammate approval with no payload when updatedInput is absent', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    vi.spyOn(controller, 'sendControlRequest').mockResolvedValue({
      subtype: 'success',
      request_id: 'teammate-request-no-input',
      response: { behavior: 'allow' },
    });
    const respond = vi.fn().mockResolvedValue(undefined);

    await controller.handleTeammateApproval({
      teammateName: 'worker',
      toolName: 'run_shell_command',
      toolInput: { command: 'ls' },
      respond,
      timestamp: 789,
    });

    expect(respond).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
  });

  it('includes teammate Plan shell warnings in permission suggestions', async () => {
    const controller = new PermissionController(
      createContext(120_000),
      createRegistry(),
      'PermissionController',
    );
    const send = vi.spyOn(controller, 'sendControlRequest').mockResolvedValue({
      subtype: 'success',
      request_id: 'teammate-warning',
      response: { behavior: 'deny' },
    });

    await controller.handleTeammateApproval({
      teammateName: 'worker',
      toolName: 'run_shell_command',
      toolInput: { command: "python -c 'print(1)'" },
      confirmationDetails: {
        type: 'exec',
        title: 'Confirm shell',
        command: "python -c 'print(1)'",
        rootCommand: 'python',
        hideAlwaysAllow: true,
        warnings: ['Exact one-off approval required'],
      },
      respond: vi.fn().mockResolvedValue(undefined),
      timestamp: 790,
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        permission_suggestions: expect.arrayContaining([
          expect.objectContaining({
            type: 'allow',
            description: expect.stringContaining(
              'Exact one-off approval required',
            ),
          }),
        ]),
      }),
      undefined,
      expect.any(AbortSignal),
    );
  });

  it('omits modify suggestions when edit confirmation hides modify actions', () => {
    const controller = new PermissionController(
      createContext(),
      createRegistry(),
      'PermissionController',
    );

    const suggestions = controller.buildPermissionSuggestions({
      type: 'edit',
      title: 'Confirm Sed Edit',
      fileName: 'file.txt',
      hideModify: true,
    });

    expect(suggestions).toEqual([
      {
        type: 'allow',
        label: 'Allow Edit',
        description: 'Edit file: file.txt',
      },
      {
        type: 'deny',
        label: 'Deny',
        description: 'Block this file edit',
      },
    ]);
  });
});
