/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../utils/auth-type.js';
import type { ContentGeneratorConfig } from './contentGenerator.js';
import { getBuiltinGeminiReasoning } from './gemini-reasoning.js';
import {
  getEffectiveReasoning,
  resolveReasoningCapabilities,
} from './reasoning-overrides.js';

const route: ContentGeneratorConfig = {
  model: 'gemini-4-neon',
  authType: AuthType.USE_GEMINI,
  baseUrl: 'https://proxy.example.test',
};

describe('built-in Gemini 4 reasoning', () => {
  it('recognizes Gemini and Vertex routes with normalized Gemini 4 ids', () => {
    expect(getBuiltinGeminiReasoning(route)).toMatchObject({
      profile: 'gemini',
      thinking: true,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      disableField: 'thinking',
    });
    expect(
      getBuiltinGeminiReasoning({
        ...route,
        authType: AuthType.USE_VERTEX_AI,
        model: 'vertex_ai/gemini-4-pro-preview-20261121',
      }),
    ).toMatchObject({ profile: 'gemini', defaultEffort: 'high' });
  });

  it.each([
    { ...route, authType: AuthType.USE_OPENAI },
    { ...route, model: 'gemini-3-pro' },
  ])('does not infer Gemini 4 capabilities for %j', (candidate) => {
    expect(getBuiltinGeminiReasoning(candidate)).toBeUndefined();
    expect(resolveReasoningCapabilities(candidate, undefined)).toBeUndefined();
  });

  it('resolves the built-in ladder when no capability is declared', () => {
    const resolved = resolveReasoningCapabilities(route, undefined);
    expect(resolved).toMatchObject({
      profile: 'gemini',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    });
    expect(getEffectiveReasoning(route, resolved)).toEqual({ effort: 'high' });
    expect(
      getEffectiveReasoning(
        { ...route, reasoning: { effort: 'xhigh' } },
        resolved,
      ),
    ).toEqual({ effort: 'high' });
    expect(
      getEffectiveReasoning({ ...route, reasoning: false }, resolved),
    ).toBe(false);
    expect(route.reasoning).toBeUndefined();
  });

  it('inherits the native format and ladder in a partial declaration', () => {
    expect(
      resolveReasoningCapabilities(route, { defaultEffort: 'medium' }),
    ).toMatchObject({
      profile: 'gemini',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      disableField: 'thinking',
    });
  });

  it('clamps an inherited default into a declared narrower ladder', () => {
    const resolved = resolveReasoningCapabilities(route, {
      efforts: ['low', 'medium'],
    });
    expect(resolved).toMatchObject({
      profile: 'gemini',
      efforts: ['low', 'medium'],
      defaultEffort: 'medium',
    });
    expect(getEffectiveReasoning(route, resolved)).toEqual({
      effort: 'medium',
    });
  });

  it('keeps an explicit narrower declaration', () => {
    expect(
      resolveReasoningCapabilities(route, {
        profile: 'gemini',
        efforts: ['low'],
        defaultEffort: 'low',
      }),
    ).toMatchObject({ efforts: ['low'], defaultEffort: 'low' });
  });

  it('preserves mandatory thinking', () => {
    const mandatory = {
      ...route,
      thinkingMandatory: true,
    };
    const resolved = resolveReasoningCapabilities(mandatory, undefined);
    expect(resolved?.canDisable).toBe(false);
    expect(
      getEffectiveReasoning({ ...mandatory, reasoning: false }, resolved),
    ).toEqual({ effort: 'high' });
  });
});
