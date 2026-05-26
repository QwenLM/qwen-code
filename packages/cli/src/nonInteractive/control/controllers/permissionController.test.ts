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
});
