/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getModelReasoningPreference,
  mergeModelReasoningPreference,
} from './model-reasoning-preferences.js';
import type { Settings } from './settings.js';

function makeSettings(model: unknown): Settings {
  return { model } as unknown as Settings;
}

describe('model-reasoning-preferences', () => {
  describe('getModelReasoningPreference', () => {
    it('returns undefined when model.reasoningPreferences is absent', () => {
      const settings = makeSettings({ name: 'qwen3.8-max' });

      expect(
        getModelReasoningPreference(settings, 'qwen3.8-max'),
      ).toBeUndefined();
    });

    it('returns undefined when model.reasoningPreferences is an array', () => {
      const settings = makeSettings({ reasoningPreferences: [] });

      expect(
        getModelReasoningPreference(settings, 'qwen3.8-max'),
      ).toBeUndefined();
    });

    it('returns undefined when model.reasoningPreferences is not an object', () => {
      const settings = makeSettings({ reasoningPreferences: 'low' });

      expect(
        getModelReasoningPreference(settings, 'qwen3.8-max'),
      ).toBeUndefined();
    });

    it('returns the entry for the matching base model id', () => {
      const preference = { thinkingEnabled: false, effort: 'medium' };
      const settings = makeSettings({
        reasoningPreferences: { 'qwen3.8-max': preference },
      });

      expect(getModelReasoningPreference(settings, 'qwen3.8-max')).toEqual(
        preference,
      );
    });

    it('returns undefined for a model with no entry', () => {
      const settings = makeSettings({
        reasoningPreferences: {
          'qwen3.8-max': { effort: 'medium' },
        },
      });

      expect(
        getModelReasoningPreference(settings, 'qwen3.8-max-preview'),
      ).toBeUndefined();
    });
  });

  describe('mergeModelReasoningPreference', () => {
    it('merges the patch into an existing entry, preserving other keys', () => {
      const settings = makeSettings({
        reasoningPreferences: {
          'qwen3.8-max': { thinkingEnabled: false, effort: 'low' },
        },
      });

      expect(
        mergeModelReasoningPreference(settings, 'qwen3.8-max', {
          effort: 'medium',
        }),
      ).toEqual({
        'qwen3.8-max': { thinkingEnabled: false, effort: 'medium' },
      });
    });

    it('keeps sibling model entries untouched', () => {
      const settings = makeSettings({
        reasoningPreferences: {
          'qwen3.8-max': { effort: 'low' },
          'other-model': { thinkingEnabled: true },
        },
      });

      const merged = mergeModelReasoningPreference(settings, 'qwen3.8-max', {
        effort: 'medium',
      });

      expect(merged['other-model']).toEqual({ thinkingEnabled: true });
      expect(merged['qwen3.8-max']).toEqual({ effort: 'medium' });
    });

    it('treats a missing preferences root as empty', () => {
      const settings = makeSettings({ name: 'qwen3.8-max' });

      expect(
        mergeModelReasoningPreference(settings, 'qwen3.8-max', {
          effort: 'low',
        }),
      ).toEqual({ 'qwen3.8-max': { effort: 'low' } });
    });

    it('treats an invalid preferences root as empty', () => {
      for (const reasoningPreferences of [[], 'low']) {
        const settings = makeSettings({ reasoningPreferences });

        expect(
          mergeModelReasoningPreference(settings, 'qwen3.8-max', {
            thinkingEnabled: false,
          }),
        ).toEqual({ 'qwen3.8-max': { thinkingEnabled: false } });
      }
    });

    it('replaces a non-object existing entry with the patch', () => {
      const settings = makeSettings({
        reasoningPreferences: { 'qwen3.8-max': 'garbage' },
      });

      expect(
        mergeModelReasoningPreference(settings, 'qwen3.8-max', {
          effort: 'high',
        }),
      ).toEqual({ 'qwen3.8-max': { effort: 'high' } });
    });

    it('replaces an array existing entry with the patch', () => {
      const settings = makeSettings({
        reasoningPreferences: { 'qwen3.8-max': [{ effort: 'low' }] },
      });

      expect(
        mergeModelReasoningPreference(settings, 'qwen3.8-max', {
          effort: 'high',
        }),
      ).toEqual({ 'qwen3.8-max': { effort: 'high' } });
    });

    it('returns the full preferences record with the merged entry', () => {
      const settings = makeSettings({
        reasoningPreferences: {
          'qwen3.8-max': { effort: 'low' },
          'other-model': { thinkingEnabled: true },
        },
      });

      expect(
        mergeModelReasoningPreference(settings, 'qwen3.8-max', {
          thinkingEnabled: false,
          effort: 'xhigh',
        }),
      ).toEqual({
        'qwen3.8-max': { thinkingEnabled: false, effort: 'xhigh' },
        'other-model': { thinkingEnabled: true },
      });
    });
  });
});
