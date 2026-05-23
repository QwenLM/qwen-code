/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import { resolveModelId } from './modelId.js';

describe('resolveModelId', () => {
  it('returns undefined for omitted models without a current model', () => {
    expect(resolveModelId(undefined)).toBeUndefined();
  });

  it('resolves omitted models to the current model when provided', () => {
    expect(
      resolveModelId(undefined, {
        currentModel: 'main-model',
        currentAuthType: AuthType.USE_ANTHROPIC,
      }),
    ).toEqual({
      authType: AuthType.USE_ANTHROPIC,
      modelId: 'main-model',
    });
  });

  it('resolves explicit inherit to the current model', () => {
    expect(
      resolveModelId('inherit', {
        currentModel: 'main-model',
        currentAuthType: AuthType.USE_OPENAI,
      }),
    ).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'main-model',
    });
  });

  it('returns undefined for fast when no fast model is available', () => {
    expect(resolveModelId('fast')).toBeUndefined();
  });

  it('resolves fast to the configured fast model', () => {
    expect(resolveModelId('fast', { fastModel: 'fast-model' })).toEqual({
      modelId: 'fast-model',
    });
  });

  it('resolves fast to authType-prefixed configured fast models', () => {
    expect(resolveModelId('fast', { fastModel: 'openai:fast-model' })).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'fast-model',
    });
  });

  it('returns undefined for recursive fast selectors', () => {
    expect(resolveModelId('fast', { fastModel: 'fast' })).toBeUndefined();
  });

  it('parses bare model IDs to concrete model IDs', () => {
    expect(resolveModelId('glm-5')).toEqual({
      modelId: 'glm-5',
    });
  });

  it('parses authType-prefixed model IDs', () => {
    expect(resolveModelId('openai:glm-5')).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'glm-5',
    });
  });

  it('trims authType-prefixed model IDs', () => {
    expect(resolveModelId(' openai : glm-5 ')).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'glm-5',
    });
  });

  it('treats unknown prefix as bare model ID (colon in model ID)', () => {
    expect(resolveModelId('invalid:glm-5')).toEqual({
      modelId: 'invalid:glm-5',
    });
  });

  it('treats model IDs with colons as bare model IDs', () => {
    expect(resolveModelId('gpt-4o:online')).toEqual({
      modelId: 'gpt-4o:online',
    });
  });

  it('rejects missing model IDs after valid authType prefixes', () => {
    expect(() => resolveModelId('openai:')).toThrow(
      'Model selector must include a model ID after the authType',
    );
  });
});
