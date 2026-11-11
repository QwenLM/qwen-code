/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Model } from '../provider/model/model.js';
import {
  isGen3Model,
  isCustomModel,
  isAutoModel,
  getDisplayString,
  getSkillListingColumnsPerToken,
  supportsMultimodalFunctionResponse,
  isProModel,
  MODEL_ALIAS_AUTO,
} from './models.js';
import { testListedModel } from '../test-utils/listed-model.js';

describe('Qoder model helpers', () => {
  describe('getSkillListingColumnsPerToken', () => {
    it.each([
      [undefined, 4],
      ['', 4],
      ['claude-opus-4-6', 4],
      ['claude-opus-4-7', 3],
      ['claude-sonnet-4-7', 3],
      ['claude-opus-5', 3],
      ['qwen-max', 3],
      ['claude-3-5-sonnet-20241022', 4],
      ['us.anthropic.claude-opus-4-6-v1:0', 4],
      ['Claude_Opus_4.6', 4],
      ['claude-opus-4', 4],
      ['claude-sonnet-4-20250514', 4],
    ])('selects the listing estimate for %s', (model, columns) => {
      expect(getSkillListingColumnsPerToken(undefined, model)).toBe(columns);
    });

    it.each([
      { entry: { key: 'claude-opus-4-6' }, columns: 4 },
      {
        entry: {
          key: 'provider/legacy',
          connection: { model: 'claude-opus-4-6' },
        },
        columns: 4,
      },
      {
        entry: {
          key: 'claude-opus-4-6',
          connection: { model: 'claude-opus-4-7' },
        },
        columns: 3,
      },
    ])(
      'uses the listed model identity $entry for a display name',
      ({ entry, columns }) => {
        expect(
          getSkillListingColumnsPerToken(
            entry as unknown as Model,
            'Selected model',
          ),
        ).toBe(columns);
      },
    );
  });

  describe('isAutoModel', () => {
    it('only treats Qoder auto as an auto model', () => {
      expect(isAutoModel(MODEL_ALIAS_AUTO)).toBe(true);
      expect(isAutoModel('auto-gemini-2.5')).toBe(false);
      expect(isAutoModel('qwen-max')).toBe(false);
    });
  });

  describe('getDisplayString', () => {
    it('优先使用模型展示名', () => {
      expect(
        getDisplayString(
          testListedModel('internal', {
            display_name: 'display label',
          }),
        ),
      ).toBe('Display label');
    });
    it('uses Qoder auto display text and falls back to capitalized keys', () => {
      expect(getDisplayString(undefined, 'auto')).toBe('Auto');
      expect(getDisplayString(undefined, 'qwen-max')).toBe('Qwen-max');
    });
  });

  describe('isCustomModel', () => {
    it('treats non-auto model keys as explicit model selections', () => {
      expect(isCustomModel('qwen-max')).toBe(true);
      expect(isCustomModel('auto')).toBe(false);
    });
  });

  describe('isProModel', () => {
    it('keeps simple pro-name detection for quota copy', () => {
      expect(isProModel('qwen-pro')).toBe(true);
      expect(isProModel('qwen-max')).toBe(false);
    });
  });

  describe('isGen3Model', () => {
    it('is retained only for direct legacy compatibility checks', () => {
      expect(isGen3Model('gemini-3-pro-preview')).toBe(true);
      expect(isGen3Model('qwen-max')).toBe(false);
    });
  });

  describe('supportsMultimodalFunctionResponse', () => {
    it('defaults to false when the model is not present in the Qoder catalog', () => {
      expect(supportsMultimodalFunctionResponse(undefined)).toBe(false);
    });
  });
});
