/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createMinimalSettings } from '../../../config/settings.js';
import type { StreamJsonOutputAdapter } from '../../io/StreamJsonOutputAdapter.js';
import type { IControlContext } from '../ControlContext.js';
import type { IPendingRequestRegistry } from './baseController.js';
import { SdkMcpController } from './sdkMcpController.js';

function createRegistry(): IPendingRequestRegistry {
  return {
    registerIncomingRequest: vi.fn(),
    deregisterIncomingRequest: vi.fn(),
    registerOutgoingRequest: vi.fn(),
    deregisterOutgoingRequest: vi.fn(),
  };
}

describe('SdkMcpController', () => {
  it('binds an SDK MCP request to the turn that created it', async () => {
    const session = new AbortController();
    const firstTurn = new AbortController();
    const secondTurn = new AbortController();
    let activeTurnSignal = firstTurn.signal;
    const context: IControlContext = {
      config: {
        getDebugMode: vi.fn().mockReturnValue(false),
      } as unknown as IControlContext['config'],
      streamJson: { send: vi.fn() } as unknown as StreamJsonOutputAdapter,
      sessionId: 'test-session-id',
      abortSignal: session.signal,
      getActiveTurnAbortSignal: () => activeTurnSignal,
      debugMode: false,
      settings: createMinimalSettings(),
      permissionMode: 'default',
      sdkMcpServers: new Set<string>(),
      mcpClients: new Map(),
      inputClosed: false,
    };
    const controller = new SdkMcpController(
      context,
      createRegistry(),
      'SdkMcpController',
    );
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(controller, 'sendControlRequest').mockImplementation(
      (_payload, _timeout, signal) => {
        requestSignal = signal;
        return new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('Request aborted')),
            { once: true },
          );
        });
      },
    );
    const sendMcpMessage = controller.createSendSdkMcpMessage();
    const request = sendMcpMessage('sdk-server', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    } as JSONRPCMessage);
    const result = request.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    await vi.waitFor(() => {
      expect(requestSignal).toBeDefined();
    });
    activeTurnSignal = secondTurn.signal;
    firstTurn.abort();

    await expect(result).resolves.toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: 'Request aborted' }),
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(session.signal.aborted).toBe(false);
    expect(secondTurn.signal.aborted).toBe(false);

    requestSignal = undefined;
    const sessionRequest = sendMcpMessage('sdk-server', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    } as JSONRPCMessage);
    const sessionResult = sessionRequest.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await vi.waitFor(() => {
      expect(requestSignal).toBeDefined();
    });
    const sessionOwnedSignal = requestSignal as AbortSignal | undefined;
    session.abort();

    await expect(sessionResult).resolves.toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: 'Request aborted' }),
    });
    expect(sessionOwnedSignal?.aborted).toBe(true);
    expect(secondTurn.signal.aborted).toBe(false);
  });
});
