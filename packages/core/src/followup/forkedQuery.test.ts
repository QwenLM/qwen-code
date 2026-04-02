/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveCacheSafeParams,
  getCacheSafeParams,
  clearCacheSafeParams,
} from './forkedQuery.js';
import type { GenerateContentConfig } from '@google/genai';

describe('CacheSafeParams', () => {
  beforeEach(() => {
    clearCacheSafeParams();
  });

  describe('saveCacheSafeParams / getCacheSafeParams', () => {
    it('saves and retrieves params', () => {
      const config: GenerateContentConfig = {
        systemInstruction: 'You are helpful',
        tools: [{ functionDeclarations: [] }],
      };

      saveCacheSafeParams(config, [], 'qwen-max');

      const params = getCacheSafeParams();
      expect(params).not.toBeNull();
      expect(params!.model).toBe('qwen-max');
      expect(params!.history).toEqual([]);
      expect(params!.version).toBeGreaterThan(0);
    });

    it('deep clones generationConfig', () => {
      const config: GenerateContentConfig = {
        systemInstruction: 'test',
        tools: [{ functionDeclarations: [{ name: 'tool1' }] }],
      };

      saveCacheSafeParams(config, [], 'model');

      // Mutate original — should not affect saved params
      (
        config.tools![0] as { functionDeclarations: unknown[] }
      ).functionDeclarations.push({ name: 'tool2' });

      const params = getCacheSafeParams();
      const savedTools = params!.generationConfig.tools as Array<{
        functionDeclarations: unknown[];
      }>;
      expect(savedTools[0].functionDeclarations).toHaveLength(1);
    });
  });

  describe('clearCacheSafeParams', () => {
    it('clears saved params', () => {
      saveCacheSafeParams({}, [], 'model');
      expect(getCacheSafeParams()).not.toBeNull();

      clearCacheSafeParams();
      expect(getCacheSafeParams()).toBeNull();
    });
  });

  describe('version detection', () => {
    it('increments version when systemInstruction changes', () => {
      saveCacheSafeParams({ systemInstruction: 'version1' }, [], 'model');
      const v1 = getCacheSafeParams()!.version;

      saveCacheSafeParams({ systemInstruction: 'version2' }, [], 'model');
      const v2 = getCacheSafeParams()!.version;

      expect(v2).toBeGreaterThan(v1);
    });

    it('increments version when tools change', () => {
      saveCacheSafeParams(
        { tools: [{ functionDeclarations: [{ name: 'a' }] }] },
        [],
        'model',
      );
      const v1 = getCacheSafeParams()!.version;

      saveCacheSafeParams(
        { tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }] }] },
        [],
        'model',
      );
      const v2 = getCacheSafeParams()!.version;

      expect(v2).toBeGreaterThan(v1);
    });

    it('does not increment version when only history changes', () => {
      const config: GenerateContentConfig = {
        systemInstruction: 'stable',
        tools: [],
      };

      saveCacheSafeParams(config, [], 'model');
      const v1 = getCacheSafeParams()!.version;

      saveCacheSafeParams(
        config,
        [{ role: 'user', parts: [{ text: 'hi' }] }],
        'model',
      );
      const v2 = getCacheSafeParams()!.version;

      expect(v2).toBe(v1);
    });
  });
});
