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

function createContext(
  overrides: Partial<IControlContext> = {},
): IControlContext {
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
      setReasoningEffort: vi.fn(),
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      getAvailableModels: vi.fn().mockReturnValue([]),
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
    ...overrides,
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

  describe('continue_last_turn', () => {
    it('delegates to the session callback and merges its payload', async () => {
      const onContinueLastTurn = vi.fn().mockResolvedValue({
        accepted: true,
        interruption: 'interrupted_turn',
      });
      const controller = new SystemController(
        createContext({ onContinueLastTurn }),
        createRegistry(),
        'SystemController',
      );

      const result = await controller.handleRequest(
        { subtype: 'continue_last_turn' },
        'continue-1',
      );

      expect(onContinueLastTurn).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        subtype: 'continue_last_turn',
        accepted: true,
        interruption: 'interrupted_turn',
      });
    });

    it('fails loudly when no session callback is registered', async () => {
      const controller = new SystemController(
        createContext(),
        createRegistry(),
        'SystemController',
      );

      await expect(
        controller.handleRequest(
          { subtype: 'continue_last_turn' },
          'continue-2',
        ),
      ).rejects.toThrow(/was not registered on ControlContext/);
    });
  });

  describe('set_effort', () => {
    it('sets effort and returns applied=true when read-back matches', async () => {
      const context = createContext();
      (
        context.config.getReasoningEffort as ReturnType<typeof vi.fn>
      ).mockReturnValue('high');
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      const result = await controller.handleRequest(
        { subtype: 'set_effort', effort: 'high' },
        'effort-1',
      );

      expect(context.config.setReasoningEffort).toHaveBeenCalledWith('high');
      expect(result).toEqual({
        subtype: 'set_effort',
        effort: 'high',
        applied: true,
      });
    });

    it('returns applied=false when thinking is disabled (read-back mismatch)', async () => {
      const context = createContext();
      (
        context.config.getReasoningEffort as ReturnType<typeof vi.fn>
      ).mockReturnValue('medium');
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      const result = await controller.handleRequest(
        { subtype: 'set_effort', effort: 'high' },
        'effort-2',
      );

      expect(result).toEqual({
        subtype: 'set_effort',
        effort: 'high',
        applied: false,
      });
    });

    it('rejects invalid effort value', async () => {
      const controller = new SystemController(
        createContext(),
        createRegistry(),
        'SystemController',
      );

      await expect(
        controller.handleRequest(
          { subtype: 'set_effort', effort: 'banana' },
          'effort-3',
        ),
      ).rejects.toThrow('Invalid effort value');
    });

    it('rejects empty effort string', async () => {
      const controller = new SystemController(
        createContext(),
        createRegistry(),
        'SystemController',
      );

      await expect(
        controller.handleRequest(
          { subtype: 'set_effort', effort: '  ' },
          'effort-4',
        ),
      ).rejects.toThrow('Invalid effort specified');
    });
  });

  describe('get_available_models', () => {
    it('returns models without exposing baseUrl or envKey', async () => {
      const context = createContext();
      (
        context.config.getAvailableModels as ReturnType<typeof vi.fn>
      ).mockReturnValue([
        {
          id: 'qwen-max',
          label: 'Qwen Max',
          capabilities: { vision: true },
          contextWindowSize: 128000,
          baseUrl: 'https://internal-proxy.corp/v1',
          envKey: 'SECRET_API_KEY',
        },
        {
          id: 'qwen-image-2.0',
          label: 'Qwen Image 2.0',
          imageOnly: true,
        },
      ]);
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      const result = await controller.handleRequest(
        { subtype: 'get_available_models' },
        'models-1',
      );

      expect(result).toEqual({
        subtype: 'get_available_models',
        models: [
          {
            id: 'qwen-max',
            label: 'Qwen Max',
            capabilities: { vision: true },
            contextWindowSize: 128000,
          },
        ],
      });
    });

    it('returns empty models list when none available', async () => {
      const controller = new SystemController(
        createContext(),
        createRegistry(),
        'SystemController',
      );

      const result = await controller.handleRequest(
        { subtype: 'get_available_models' },
        'models-2',
      );

      expect(result).toEqual({
        subtype: 'get_available_models',
        models: [],
      });
    });
  });

  describe('get_usage_info', () => {
    it('returns dashboard with subtype when range is provided', async () => {
      const controller = new SystemController(
        createContext(),
        createRegistry(),
        'SystemController',
      );

      const result = await controller.handleRequest(
        { subtype: 'get_usage_info', range: 'week' },
        'usage-1',
      );

      expect(result).toHaveProperty('subtype', 'get_usage_info');
      expect(result).toHaveProperty('generatedAt');
      expect(result).toHaveProperty('summary');
    });

    it('returns dashboard without range filter', async () => {
      const controller = new SystemController(
        createContext(),
        createRegistry(),
        'SystemController',
      );

      const result = await controller.handleRequest(
        { subtype: 'get_usage_info' },
        'usage-2',
      );

      expect(result).toHaveProperty('subtype', 'get_usage_info');
      expect(result).toHaveProperty('generatedAt');
    });
  });

  describe('initialize with effort', () => {
    it('sets effort during initialize when provided', async () => {
      const context = createContext();
      (
        context.config.getReasoningEffort as ReturnType<typeof vi.fn>
      ).mockReturnValue('high');
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      const result = await controller.handleRequest(
        { subtype: 'initialize', effort: 'high' },
        'init-effort-1',
      );

      expect(context.config.setReasoningEffort).toHaveBeenCalledWith('high');
      expect(result).toHaveProperty('subtype', 'initialize');
      expect(result).toHaveProperty('session_id', 'test-session-id');
    });

    it('warns when effort not applied during initialize (thinking disabled)', async () => {
      const context = createContext();
      (
        context.config.getReasoningEffort as ReturnType<typeof vi.fn>
      ).mockReturnValue('medium');
      const controller = new SystemController(
        context,
        createRegistry(),
        'SystemController',
      );

      const result = await controller.handleRequest(
        { subtype: 'initialize', effort: 'high' },
        'init-effort-2',
      );

      expect(context.config.setReasoningEffort).toHaveBeenCalledWith('high');
      expect(context.config.getReasoningEffort).toHaveBeenCalled();
      expect(result).toHaveProperty('subtype', 'initialize');
    });

    it('rejects invalid effort during initialize', async () => {
      const controller = new SystemController(
        createContext(),
        createRegistry(),
        'SystemController',
      );

      await expect(
        controller.handleRequest(
          { subtype: 'initialize', effort: 'banana' },
          'init-effort-3',
        ),
      ).rejects.toThrow('Invalid effort value');
    });
  });
});
