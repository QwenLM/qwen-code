/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerWorkspaceAuthRoutes,
  resetDeepinfraModelsCacheForTest,
} from './workspace-auth.js';
import type { DeviceFlowRegistry } from '../auth/device-flow.js';

const mockClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUndiciFetch = vi.hoisted(() => vi.fn());
const mockEnvHttpProxyAgent = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    close: mockClose,
  })),
);

vi.mock('../../utils/load-undici.js', () => ({
  loadUndici: async () => ({
    fetch: mockUndiciFetch,
    EnvHttpProxyAgent: mockEnvHttpProxyAgent,
  }),
}));

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
    mockUndiciFetch.mockReset();
    mockClose.mockClear();
    mockEnvHttpProxyAgent.mockImplementation(() => ({
      close: mockClose,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('GET /workspace/auth/deepinfra-models', () => {
    it('fetches models from DeepInfra with proxy dispatcher and returns 200 with data (R1-32)', async () => {
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

      mockUndiciFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      });

      const res = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockModels);
      expect(mockEnvHttpProxyAgent).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
      expect(mockUndiciFetch).toHaveBeenCalledWith(
        'https://api.deepinfra.com/models/list',
        expect.objectContaining({
          dispatcher: expect.any(Object),
          headers: expect.objectContaining({
            Accept: 'application/json',
            'User-Agent': 'qwen-code',
          }),
        }),
      );
    });

    it('filters out non-chat, anthropic/*, and deprecated models from DeepInfra response', async () => {
      const app = makeApp();
      const mockModels = [
        { model_name: 'deepseek-ai/DeepSeek-V3', type: 'text-generation' },
        { model_name: 'anthropic/claude-3-5-sonnet', type: 'text-generation' },
        {
          model_name: 'meta-llama/Llama-Guard-3-8B',
          type: 'text-classification',
        },
        {
          model_name: 'old-model',
          type: 'text-generation',
          deprecated: 1700000000, // in the past
        },
        {
          model_name: 'deprecated-bool-model',
          type: 'text-generation',
          deprecated: true,
        },
      ];

      mockUndiciFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      });

      const res = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { model_name: 'deepseek-ai/DeepSeek-V3', type: 'text-generation' },
      ]);
    });

    it('uses in-memory cache for subsequent requests within TTL', async () => {
      const app = makeApp();
      const mockModels = [
        {
          model_name: 'test-model',
          type: 'text-generation',
        },
      ];

      mockUndiciFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      });

      const res1 = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res1.status).toBe(200);
      expect(res1.body).toEqual(mockModels);

      // Second call within TTL should return cached data without fetching again
      const res2 = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(mockModels);
      expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent requests with single-flight (R1-18)', async () => {
      const app = makeApp();
      const mockModels = [
        {
          model_name: 'single-flight-model',
          type: 'text-generation',
        },
      ];

      let resolveFetch!: (value: unknown) => void;
      mockUndiciFetch.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const p1 = request(app).get('/workspace/auth/deepinfra-models');
      const p2 = request(app).get('/workspace/auth/deepinfra-models');
      const p3 = request(app).get('/workspace/auth/deepinfra-models');

      resolveFetch({
        ok: true,
        json: async () => mockModels,
      });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(r1.body).toEqual(mockModels);
      expect(r2.body).toEqual(mockModels);
      expect(r3.body).toEqual(mockModels);
      expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
    });

    it('aborts and returns 502 when response body hangs past timeout (R1-1)', async () => {
      const app = makeApp();
      mockUndiciFetch.mockImplementationOnce(
        async (_url: string, opts: { signal: AbortSignal }) => {
          expect(opts.signal).toBeDefined();
          return {
            ok: true,
            json: async () => {
              const abortErr = new Error('This operation was aborted');
              abortErr.name = 'AbortError';
              throw abortErr;
            },
          };
        },
      );

      const res = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('upstream_error');
      expect(mockClose).toHaveBeenCalled();
    });

    it('returns 502 upstream_error when DeepInfra API fails and no cache exists', async () => {
      const app = makeApp();
      mockUndiciFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const res = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('upstream_error');
    });

    it('falls back to stale cache when upstream fetch fails past TTL (R1-2)', async () => {
      const app = makeApp();
      const mockModels = [
        { model_name: 'cached-model', type: 'text-generation' },
      ];

      vi.useFakeTimers({ toFake: ['Date'] });

      // Prime cache
      mockUndiciFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockModels,
      });

      await request(app).get('/workspace/auth/deepinfra-models');
      expect(mockUndiciFetch).toHaveBeenCalledTimes(1);

      // Advance clock past 1 hour TTL
      vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1000);

      // Next request fails, but stale cache should be returned
      mockUndiciFetch.mockRejectedValueOnce(new Error('Network error'));

      const res = await request(app).get('/workspace/auth/deepinfra-models');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockModels);
      expect(mockUndiciFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });
});
