/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCodingPlanUpdates } from './useCodingPlanUpdates.js';
import {
  CODING_PLAN_ENV_KEY,
  getCodingPlanConfig,
  CodingPlanRegion,
} from '../../constants/codingPlan.js';
import { AuthType } from '@qwen-code/qwen-code-core';

// Get region configs for testing
const chinaConfig = getCodingPlanConfig(CodingPlanRegion.CHINA);
const globalConfig = getCodingPlanConfig(CodingPlanRegion.GLOBAL);

describe('useCodingPlanUpdates', () => {
  const mockSettings = {
    merged: {
      modelProviders: {},
      codingPlan: {},
    },
    setValue: vi.fn(),
    isTrusted: true,
    workspace: { settings: {} },
    user: { settings: {} },
  };

  const mockConfig = {
    reloadModelProvidersConfig: vi.fn(),
    refreshAuth: vi.fn(),
    getModel: vi.fn().mockReturnValue('qwen-max'),
  };

  const mockAddItem = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[CODING_PLAN_ENV_KEY];
  });

  describe('version comparison', () => {
    it('should not show update prompt when no version is stored', () => {
      mockSettings.merged.codingPlan = {};

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      expect(result.current.codingPlanUpdateRequest).toBeUndefined();
    });

    it('should not show update prompt when China region versions match', () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.CHINA,
        version: chinaConfig.version,
      };

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      expect(result.current.codingPlanUpdateRequest).toBeUndefined();
    });

    it('should not show update prompt when Global region versions match', () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.GLOBAL,
        version: globalConfig.version,
      };

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      expect(result.current.codingPlanUpdateRequest).toBeUndefined();
    });

    it('should default to China region when region is not specified', async () => {
      // No region specified, should default to China
      mockSettings.merged.codingPlan = {
        version: 'old-version-hash',
      };

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      // Should prompt for China region since it defaults to China
      expect(result.current.codingPlanUpdateRequest?.prompt).toContain(
        'Alibaba Cloud Coding Plan',
      );
    });

    it('should show update prompt when China region versions differ', async () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.CHINA,
        version: 'old-version-hash',
      };

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      expect(result.current.codingPlanUpdateRequest?.prompt).toContain(
        'Alibaba Cloud Coding Plan',
      );
    });

    it('should show update prompt when Global region versions differ', async () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.GLOBAL,
        version: 'old-version-hash',
      };

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      expect(result.current.codingPlanUpdateRequest?.prompt).toContain(
        'Alibaba Cloud Coding Plan',
      );
    });
  });

  describe('update execution', () => {
    it('should execute China region update when user confirms', async () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.CHINA,
        version: 'old-version-hash',
      };
      mockSettings.merged.modelProviders = {
        [AuthType.USE_OPENAI]: [
          {
            id: 'test-model-china-1',
            baseUrl: chinaConfig.baseUrl,
            envKey: CODING_PLAN_ENV_KEY,
          },
          {
            id: 'custom-model',
            baseUrl: 'https://custom.example.com',
            envKey: 'CUSTOM_API_KEY',
          },
        ],
      };
      mockConfig.refreshAuth.mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      // Confirm the update
      await result.current.codingPlanUpdateRequest!.onConfirm(true);

      // Wait for async update to complete
      await waitFor(() => {
        // Should update model providers (at least 2 calls: modelProviders + version + region)
        expect(mockSettings.setValue).toHaveBeenCalled();
      });

      // Should update version with correct hash
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'codingPlan.version',
        chinaConfig.version,
      );

      // Should update region
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'codingPlan.region',
        CodingPlanRegion.CHINA,
      );

      // Should reload and refresh auth
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
      expect(mockConfig.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);

      // Should show success message with region info
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: expect.stringContaining('Alibaba Cloud Coding Plan'),
        }),
        expect.any(Number),
      );
    });

    it('should execute Global region update when user confirms', async () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.GLOBAL,
        version: 'old-version-hash',
      };
      mockSettings.merged.modelProviders = {
        [AuthType.USE_OPENAI]: [
          {
            id: 'test-model-global-1',
            baseUrl: globalConfig.baseUrl,
            envKey: CODING_PLAN_ENV_KEY,
          },
          {
            id: 'custom-model',
            baseUrl: 'https://custom.example.com',
            envKey: 'CUSTOM_API_KEY',
          },
        ],
      };
      mockConfig.refreshAuth.mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      // Confirm the update
      await result.current.codingPlanUpdateRequest!.onConfirm(true);

      // Wait for async update to complete
      await waitFor(() => {
        expect(mockSettings.setValue).toHaveBeenCalled();
      });

      // Should update version with correct hash (single version field)
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'codingPlan.version',
        globalConfig.version,
      );

      // Should update region
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'codingPlan.region',
        CodingPlanRegion.GLOBAL,
      );

      // Should reload and refresh auth
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
      expect(mockConfig.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);

      // Should show success message with Global region info
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: expect.stringContaining('Alibaba Cloud Coding Plan'),
        }),
        expect.any(Number),
      );
    });

    it('should not execute update when user declines', async () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.CHINA,
        version: 'old-version-hash',
      };

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      // Decline the update
      await result.current.codingPlanUpdateRequest!.onConfirm(false);

      // Should not update anything
      expect(mockSettings.setValue).not.toHaveBeenCalled();
      expect(mockConfig.reloadModelProvidersConfig).not.toHaveBeenCalled();
    });

    it('should replace all Coding Plan configs during update (mutually exclusive)', async () => {
      // Since regions are mutually exclusive, when updating one region,
      // all Coding Plan configs should be replaced (not preserving other region configs)
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.CHINA,
        version: 'old-version-hash',
      };
      const chinaModelConfig = {
        id: 'test-model-china-1',
        baseUrl: chinaConfig.baseUrl,
        envKey: CODING_PLAN_ENV_KEY,
      };
      const globalModelConfig = {
        id: 'test-model-global-1',
        baseUrl: globalConfig.baseUrl,
        envKey: CODING_PLAN_ENV_KEY,
      };
      const customConfig = {
        id: 'custom-model',
        baseUrl: 'https://custom.example.com',
        envKey: 'CUSTOM_API_KEY',
      };
      mockSettings.merged.modelProviders = {
        [AuthType.USE_OPENAI]: [
          chinaModelConfig,
          globalModelConfig,
          customConfig,
        ],
      };
      mockConfig.refreshAuth.mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      await result.current.codingPlanUpdateRequest!.onConfirm(true);

      // Wait for async update to complete
      await waitFor(() => {
        expect(mockSettings.setValue).toHaveBeenCalled();
      });

      // Get the updated configs passed to setValue
      const setValueCalls = mockSettings.setValue.mock.calls;
      const modelProvidersCall = setValueCalls.find((call: unknown[]) =>
        (call[1] as string).includes('modelProviders'),
      );

      expect(modelProvidersCall).toBeDefined();
      const updatedConfigs = modelProvidersCall![2] as Array<
        Record<string, unknown>
      >;

      // Should have new China configs + custom config only (global config removed since regions are mutually exclusive)
      // The China template has 8 models, so we expect 8 (from template) + 1 (custom) = 9
      // Note: description field has been removed, only name field contains the branding
      expect(updatedConfigs.length).toBe(9);

      // Should NOT contain the Global config (mutually exclusive)
      expect(
        updatedConfigs.some(
          (c: Record<string, unknown>) => c['baseUrl'] === globalConfig.baseUrl,
        ),
      ).toBe(false);

      // Should contain the custom config
      expect(
        updatedConfigs.some(
          (c: Record<string, unknown>) => c['id'] === 'custom-model',
        ),
      ).toBe(true);

      // All configs should use the unified env key
      updatedConfigs.forEach((config) => {
        if (config['envKey'] === CODING_PLAN_ENV_KEY) {
          expect(config['baseUrl']).toBe(chinaConfig.baseUrl);
        }
      });

      // Should reload and refresh auth
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
      expect(mockConfig.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    });

    it('should preserve non-Coding Plan configs during update', async () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.CHINA,
        version: 'old-version-hash',
      };
      const customConfig = {
        id: 'custom-model',
        baseUrl: 'https://custom.example.com',
        envKey: 'CUSTOM_API_KEY',
      };
      mockSettings.merged.modelProviders = {
        [AuthType.USE_OPENAI]: [
          {
            id: 'test-model-china-1',
            baseUrl: chinaConfig.baseUrl,
            envKey: CODING_PLAN_ENV_KEY,
          },
          customConfig,
        ],
      };
      mockConfig.refreshAuth.mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      await result.current.codingPlanUpdateRequest!.onConfirm(true);

      // Wait for async update to complete
      await waitFor(() => {
        // Should preserve custom config - verify setValue was called
        expect(mockSettings.setValue).toHaveBeenCalled();
      });

      // Get the updated configs passed to setValue
      const setValueCalls = mockSettings.setValue.mock.calls;
      const modelProvidersCall = setValueCalls.find((call: unknown[]) =>
        (call[1] as string).includes('modelProviders'),
      );

      // Should preserve custom config
      expect(modelProvidersCall).toBeDefined();
      const updatedConfigs = modelProvidersCall![2] as Array<
        Record<string, unknown>
      >;
      expect(
        updatedConfigs.some(
          (c: Record<string, unknown>) => c['id'] === 'custom-model',
        ),
      ).toBe(true);
    });

    it('should handle update errors gracefully', async () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.CHINA,
        version: 'old-version-hash',
      };
      mockSettings.merged.modelProviders = {
        [AuthType.USE_OPENAI]: [
          {
            id: 'test-model-china-1',
            baseUrl: chinaConfig.baseUrl,
            envKey: CODING_PLAN_ENV_KEY,
          },
        ],
      };
      // Simulate an error during refreshAuth
      mockConfig.refreshAuth.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      await result.current.codingPlanUpdateRequest!.onConfirm(true);

      // Should show error message
      await waitFor(() => {
        expect(mockAddItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
          }),
          expect.any(Number),
        );
      });
    });
  });

  describe('dismissUpdate', () => {
    it('should clear update request when dismissed', async () => {
      mockSettings.merged.codingPlan = {
        region: CodingPlanRegion.CHINA,
        version: 'old-version-hash',
      };

      const { result } = renderHook(() =>
        useCodingPlanUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeDefined();
      });

      result.current.dismissCodingPlanUpdate();

      await waitFor(() => {
        expect(result.current.codingPlanUpdateRequest).toBeUndefined();
      });
    });
  });
});
