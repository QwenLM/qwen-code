/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isActiveModelSelection,
  removeModelFromProviders,
} from './model-providers-edit.js';

describe('removeModelFromProviders', () => {
  it('removes a model from a built-in provider and keeps the rest', () => {
    const providers = {
      openai: [{ id: 'gpt-4o' }, { id: 'deepseek-v4' }],
    };
    const result = removeModelFromProviders(providers, undefined, {
      authType: 'openai',
      modelId: 'gpt-4o',
    });
    expect(result.removed).toBe(true);
    expect(result.next).toEqual({ openai: [{ id: 'deepseek-v4' }] });
    // input is not mutated
    expect(providers.openai).toHaveLength(2);
  });

  it('empties the provider array (without dropping adjacent keys) on last removal', () => {
    const providers = { openai: [{ id: 'gpt-4o' }], gemini: [{ id: 'g-2.5' }] };
    const result = removeModelFromProviders(providers, undefined, {
      authType: 'openai',
      modelId: 'gpt-4o',
    });
    expect(result.removed).toBe(true);
    // openai emptied (so the merge-based settings write clears it), gemini kept.
    expect(result.next).toEqual({ openai: [], gemini: [{ id: 'g-2.5' }] });
  });

  it('resolves a custom provider id to its protocol', () => {
    const providers = {
      openai: [{ id: 'gpt-4o' }],
      idealab: [{ id: 'idea-model' }],
    };
    const result = removeModelFromProviders(
      providers,
      { idealab: 'openai' },
      { authType: 'openai', modelId: 'idea-model' },
    );
    expect(result.removed).toBe(true);
    expect(result.next).toEqual({ openai: [{ id: 'gpt-4o' }], idealab: [] });
  });

  it('disambiguates same-id models by baseUrl', () => {
    const providers = {
      openai: [
        { id: 'model-x', baseUrl: 'https://a.example' },
        { id: 'model-x', baseUrl: 'https://b.example' },
      ],
    };
    const result = removeModelFromProviders(providers, undefined, {
      authType: 'openai',
      modelId: 'model-x',
      baseUrl: 'https://b.example',
    });
    expect(result.removed).toBe(true);
    expect(result.next).toEqual({
      openai: [{ id: 'model-x', baseUrl: 'https://a.example' }],
    });
  });

  it('falls back to an id-only match when the baseUrl was normalized away', () => {
    // Stored baseUrl carries credentials; the caller's value was sanitized, so
    // it no longer matches exactly — id-only fallback still removes the model.
    const providers = {
      openai: [{ id: 'gpt-4o', baseUrl: 'https://user:pass@api.example' }],
    };
    const result = removeModelFromProviders(providers, undefined, {
      authType: 'openai',
      modelId: 'gpt-4o',
      baseUrl: 'https://api.example',
    });
    expect(result.removed).toBe(true);
    expect(result.next).toEqual({ openai: [] });
  });

  it('prefers the exact baseUrl match over the id-only fallback', () => {
    const providers = {
      openai: [
        { id: 'm', baseUrl: 'https://a.example' },
        { id: 'm', baseUrl: 'https://b.example' },
      ],
    };
    const result = removeModelFromProviders(providers, undefined, {
      authType: 'openai',
      modelId: 'm',
      baseUrl: 'https://b.example',
    });
    expect(result.next).toEqual({
      openai: [{ id: 'm', baseUrl: 'https://a.example' }],
    });
  });

  it('reports not-removed when nothing matches', () => {
    const providers = { openai: [{ id: 'gpt-4o' }] };
    const result = removeModelFromProviders(providers, undefined, {
      authType: 'openai',
      modelId: 'missing',
    });
    expect(result.removed).toBe(false);
    expect(result.next).toBe(providers);
  });
});

describe('isActiveModelSelection', () => {
  it('matches by id when no active baseUrl is pinned', () => {
    expect(
      isActiveModelSelection('gpt-4o', undefined, {
        authType: 'openai',
        modelId: 'gpt-4o',
      }),
    ).toBe(true);
  });

  it('requires baseUrl agreement when the active selection is pinned', () => {
    expect(
      isActiveModelSelection('gpt-4o', 'https://a.example', {
        authType: 'openai',
        modelId: 'gpt-4o',
        baseUrl: 'https://b.example',
      }),
    ).toBe(false);
    expect(
      isActiveModelSelection('gpt-4o', 'https://a.example', {
        authType: 'openai',
        modelId: 'gpt-4o',
        baseUrl: 'https://a.example',
      }),
    ).toBe(true);
  });

  it('does not clear a pinned active selection on an id-only delete', () => {
    // Active model is pinned to a baseUrl but the delete target has none — the
    // id-only delete may have removed a different variant, so don't clear it.
    expect(
      isActiveModelSelection('gpt-4o', 'https://a.example', {
        authType: 'openai',
        modelId: 'gpt-4o',
      }),
    ).toBe(false);
  });

  it('does not match a different active model', () => {
    expect(
      isActiveModelSelection('other', undefined, {
        authType: 'openai',
        modelId: 'gpt-4o',
      }),
    ).toBe(false);
  });
});
