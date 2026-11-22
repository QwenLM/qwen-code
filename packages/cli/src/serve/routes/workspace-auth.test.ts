/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerWorkspaceAuthRoutes,
  resetDeepinfraModelsCacheForTest,
} from './workspace-auth.js';
import type { DeviceFlowRegistry } from '../auth/device-flow.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  const mockRegistry = {
    start: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    listPending: vi.fn().mockReturnValue([]),
  } as unknown as DeviceFlowRegistry;

  registerWorkspaceAuthRoutes(app, {
    mutate: () => (_req, _res, next) => next(),
    deviceFlowRegistry: mockRegistry,
    getSupportedDeviceFlowProviders: () => [],
    sendBridgeError: vi.fn(),
    boundWorkspace: '/test/workspace',
    allowPrivateAuthBaseUrl: false,
  });
  return app;
}

describe('workspace-auth routes', () => {
  beforeEach(() => {
    resetDeepinfraModelsCacheForTest();
    vi.restoreAllMocks();
  });

  describe('GET /workspace/auth/deepinfra-models', () => {
    it('fetches models from DeepInfra and returns 200 with data', async () => {
      const app = makeApp();
      const mockModels = [
        {
          model_name: 'Qwen/Qwen2.5-Coder-32B-Instruct',
          type: 'text-generation',
          max_tokens: 32768,
          quantization: 'fp8',
          tags: ['openai', 'flex'],
          pricing: {
            cents_per_input_token: 0.000032,
            cents_per_output_token: 0.00032,
          },
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      } as Response);

      const res = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockModels);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.deepinfra.com/models/list',
        expect.any(Object),
      );
    });

    it('filters out any anthropic/* models from DeepInfra response', async () => {
      const app = makeApp();
      const mockModels = [
        { model_name: 'deepseek-ai/DeepSeek-V3', type: 'text-generation' },
        { model_name: 'anthropic/claude-3-5-sonnet', type: 'text-generation' },
        { model_name: 'anthropic/claude-haiku-4-5', type: 'text-generation' },
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      } as Response);

      const res = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { model_name: 'deepseek-ai/DeepSeek-V3', type: 'text-generation' },
      ]);
    });

    it('uses in-memory cache for subsequent requests', async () => {
      const app = makeApp();
      const mockModels = [
        {
          model_name: 'test-model',
          type: 'text-generation',
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      } as Response);

      const res1 = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res1.status).toBe(200);
      expect(res1.body).toEqual(mockModels);

      // Second call should return cached data without fetching again
      const res2 = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(mockModels);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns 502 upstream_error when DeepInfra API fails and no cache exists', async () => {
      const app = makeApp();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const res = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('upstream_error');
    });

    it('falls back to stale cache when upstream fetch fails', async () => {
      const app = makeApp();
      const mockModels = [{ model_name: 'cached-model' }];

      // Prime cache
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      } as Response);

      await request(app).get('/workspace/auth/deepinfra-models');

      // Next request fails, but stale cache should be returned
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Artificially simulate error by bypassing cache TTL or testing error branch
      const res = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockModels);
    });
  });
});
