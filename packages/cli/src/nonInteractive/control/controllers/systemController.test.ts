/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { InputFormat } from '@qwen-code/qwen-code-core';
import { createMinimalSettings } from '../../../config/settings.js';
import type { StreamJsonOutputAdapter } from '../../io/StreamJsonOutputAdapter.js';
import type { IControlContext } from '../ControlContext.js';
import type { IPendingRequestRegistry } from './baseController.js';
import { SystemController } from './systemController.js';

function createContext(): IControlContext {
  const abortController = new AbortController();

  return {
    config: {
      getDebugMode: vi.fn().mockReturnValue(false),
      getInputFormat: vi.fn().mockReturnValue(InputFormat.STREAM_JSON),
      setSdkMode: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      addMcpServers: vi.fn(),
      setSessionSubagents: vi.fn(),
      setApprovalMode: vi.fn(),
      setModel: vi.fn(),
    } as unknown as IControlContext['config'],
    streamJson: {
      send: vi.fn(),
    } as unknown as StreamJsonOutputAdapter,
    sessionId: 'test-session-id',
    abortSignal: abortController.signal,
    debugMode: false,
    settings: createMinimalSettings(),
    permissionMode: 'default',
    sdkCanUseToolTimeoutMs: undefined,
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

describe('SystemController', () => {
  describe('initialize timeout validation', () => {
    it('accepts valid timeout within bounds', async () => {
      const context = createContext();
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      await controller.handleRequest(
        {
          subtype: 'initialize',
          timeout: { canUseTool: 120_000 },
        },
        'test-1',
      );

      expect(context.sdkCanUseToolTimeoutMs).toBe(120_000);
    });

    it('accepts timeout at maximum boundary (600_000ms)', async () => {
      const context = createContext();
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      await controller.handleRequest(
        {
          subtype: 'initialize',
          timeout: { canUseTool: 600_000 },
        },
        'test-2',
      );

      expect(context.sdkCanUseToolTimeoutMs).toBe(600_000);
    });

    it('ignores timeout exceeding maximum boundary', async () => {
      const context = createContext();
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      await controller.handleRequest(
        {
          subtype: 'initialize',
          timeout: { canUseTool: 600_001 },
        },
        'test-3',
      );

      expect(context.sdkCanUseToolTimeoutMs).toBeUndefined();
    });

    it('ignores Number.MAX_VALUE timeout', async () => {
      const context = createContext();
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      await controller.handleRequest(
        {
          subtype: 'initialize',
          timeout: { canUseTool: Number.MAX_VALUE },
        },
        'test-4',
      );

      expect(context.sdkCanUseToolTimeoutMs).toBeUndefined();
    });

    it('ignores negative timeout', async () => {
      const context = createContext();
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      await controller.handleRequest(
        {
          subtype: 'initialize',
          timeout: { canUseTool: -1000 },
        },
        'test-5',
      );

      expect(context.sdkCanUseToolTimeoutMs).toBeUndefined();
    });

    it('ignores zero timeout', async () => {
      const context = createContext();
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      await controller.handleRequest(
        {
          subtype: 'initialize',
          timeout: { canUseTool: 0 },
        },
        'test-6',
      );

      expect(context.sdkCanUseToolTimeoutMs).toBeUndefined();
    });

    it('ignores Infinity timeout', async () => {
      const context = createContext();
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      await controller.handleRequest(
        {
          subtype: 'initialize',
          timeout: { canUseTool: Infinity },
        },
        'test-7',
      );

      expect(context.sdkCanUseToolTimeoutMs).toBeUndefined();
    });

    it('ignores NaN timeout', async () => {
      const context = createContext();
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      await controller.handleRequest(
        {
          subtype: 'initialize',
          timeout: { canUseTool: NaN },
        },
        'test-8',
      );

      expect(context.sdkCanUseToolTimeoutMs).toBeUndefined();
    });
  });
});
