/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import { resolveModelId, stripRuntimeSnapshotPrefix } from './modelId.js';

describe('stripRuntimeSnapshotPrefix', () => {
  it('returns bare model IDs unchanged', () => {
    expect(stripRuntimeSnapshotPrefix('qwen3.6-27b-autoround')).toBe(
      'qwen3.6-27b-autoround',
    );
  });

  it('strips a single runtime snapshot prefix', () => {
    expect(
      stripRuntimeSnapshotPrefix('$runtime|openai|qwen3.6-27b-autoround'),
    ).toBe('qwen3.6-27b-autoround');
  });

  it('strips nested runtime snapshot prefixes (corruption self-heal)', () => {
    expect(
      stripRuntimeSnapshotPrefix(
        '$runtime|openai|$runtime|openai|qwen3.6-27b-autoround',
      ),
    ).toBe('qwen3.6-27b-autoround');
  });

  it('returns the input unchanged for a malformed prefix with no model ID', () => {
    expect(stripRuntimeSnapshotPrefix('$runtime|openai|')).toBe(
      '$runtime|openai|',
    );
    expect(stripRuntimeSnapshotPrefix('$runtime|')).toBe('$runtime|');
  });
});

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

describe('resolveModelId with configured model context', () => {
  it('resolves bare model IDs under the current auth type when available', () => {
    expect(
      resolveModelId('deepseek-v4-flash', {
        currentAuthType: AuthType.USE_OPENAI,
        getAvailableModels: (authTypes) =>
          authTypes?.includes(AuthType.USE_OPENAI)
            ? [{ id: 'deepseek-v4-flash', authType: AuthType.USE_OPENAI }]
            : [
                {
                  id: 'deepseek-v4-flash',
                  authType: AuthType.USE_ANTHROPIC,
                },
              ],
      }),
    ).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'deepseek-v4-flash',
    });
  });

  it('resolves bare model IDs to another configured auth type when current auth does not own them', () => {
    expect(
      resolveModelId('deepseek-v4-flash', {
        currentAuthType: AuthType.USE_ANTHROPIC,
        getAvailableModels: (authTypes) =>
          authTypes?.includes(AuthType.USE_ANTHROPIC)
            ? []
            : [{ id: 'deepseek-v4-flash', authType: AuthType.USE_OPENAI }],
      }),
    ).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'deepseek-v4-flash',
    });
  });

  it('falls back to current auth type for bare model IDs with no configured match', () => {
    expect(
      resolveModelId('unknown-model', {
        currentAuthType: AuthType.USE_ANTHROPIC,
        getAvailableModels: () => [],
      }),
    ).toEqual({
      authType: AuthType.USE_ANTHROPIC,
      modelId: 'unknown-model',
    });
  });

  it('resolves fast through an authType-prefixed fast model', () => {
    expect(
      resolveModelId('fast', {
        currentAuthType: AuthType.USE_ANTHROPIC,
        fastModel: 'openai:deepseek-v4-flash',
      }),
    ).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'deepseek-v4-flash',
    });
  });

  it('falls back to current auth type for bare fast models without configured model context', () => {
    expect(
      resolveModelId('fast', {
        currentAuthType: AuthType.USE_ANTHROPIC,
        fastModel: 'deepseek-v4-flash',
      }),
    ).toEqual({
      authType: AuthType.USE_ANTHROPIC,
      modelId: 'deepseek-v4-flash',
    });
  });

  it('resolves bare fast models under the current auth type when available', () => {
    expect(
      resolveModelId('fast', {
        currentAuthType: AuthType.USE_OPENAI,
        fastModel: 'deepseek-v4-flash',
        getAvailableModels: (authTypes) =>
          authTypes?.includes(AuthType.USE_OPENAI)
            ? [{ id: 'deepseek-v4-flash', authType: AuthType.USE_OPENAI }]
            : [
                {
                  id: 'deepseek-v4-flash',
                  authType: AuthType.USE_ANTHROPIC,
                },
              ],
      }),
    ).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'deepseek-v4-flash',
    });
  });

  it('resolves bare fast models to their configured auth type when current auth does not own them', () => {
    expect(
      resolveModelId('fast', {
        currentAuthType: AuthType.USE_ANTHROPIC,
        fastModel: 'deepseek-v4-flash',
        getAvailableModels: (authTypes) =>
          authTypes?.includes(AuthType.USE_ANTHROPIC)
            ? []
            : [{ id: 'deepseek-v4-flash', authType: AuthType.USE_OPENAI }],
      }),
    ).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'deepseek-v4-flash',
    });
  });

  it('returns undefined for fast when no fast model is configured', () => {
    expect(
      resolveModelId('fast', {
        currentAuthType: AuthType.USE_OPENAI,
      }),
    ).toBeUndefined();
  });
});
