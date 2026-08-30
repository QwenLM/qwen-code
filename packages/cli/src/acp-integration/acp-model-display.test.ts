/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AuthType, type AvailableModel } from '@qwen-code/qwen-code-core';
import {
  buildAcpModelDisplayFields,
  parseLeadingBracketPrefix,
  shortenProviderLabel,
} from './acp-model-display.js';

function model(
  partial: Partial<AvailableModel> & Pick<AvailableModel, 'id' | 'label'>,
): AvailableModel {
  return {
    authType: AuthType.USE_OPENAI,
    ...partial,
  };
}

describe('parseLeadingBracketPrefix', () => {
  it.each([
    ['[ModelStudio Token Plan] qwen3.7-max', 'ModelStudio Token Plan'],
    [
      '[ModelStudio Token Plan for Global/Intl] qwen3.7-plus',
      'ModelStudio Token Plan for Global/Intl',
    ],
    ['[ModelStudio Coding Plan] x', 'ModelStudio Coding Plan'],
    [
      '[ModelStudio Coding Plan for Global/Intl] x',
      'ModelStudio Coding Plan for Global/Intl',
    ],
    ['[ModelStudio Standard] x', 'ModelStudio Standard'],
    ['[OpenRouter] gpt-4', 'OpenRouter'],
    ['plain-id', undefined],
    ['', undefined],
  ])('parses %s', (label, expected) => {
    expect(parseLeadingBracketPrefix(label)).toBe(expected);
  });
});

describe('shortenProviderLabel', () => {
  it.each([
    ['ModelStudio Token Plan for Global/Intl', 'Token Plan (Intl)'],
    ['ModelStudio Token Plan', 'Token Plan'],
    ['ModelStudio Coding Plan for Global/Intl', 'Coding Plan (Intl)'],
    ['ModelStudio Coding Plan', 'Coding Plan'],
    ['ModelStudio Standard', 'ModelStudio'],
    ['OpenRouter', 'OpenRouter'],
  ])('shortens %s', (raw, expected) => {
    expect(shortenProviderLabel(raw)).toBe(expected);
  });
});

describe('buildAcpModelDisplayFields', () => {
  it('uses bare id when unique and sets providerLabel + legacyName', () => {
    const m = model({
      id: 'qwen3.7-max',
      label: '[ModelStudio Token Plan] qwen3.7-max',
    });
    const [fields] = buildAcpModelDisplayFields([
      { model: m, modelId: 'qwen3.7-max(openai)' },
    ]);
    expect(fields).toEqual({
      name: 'qwen3.7-max',
      description: 'Token Plan',
      providerLabel: 'Token Plan',
      legacyName: '[ModelStudio Token Plan] qwen3.7-max',
    });
    expect(m.label).toBe('[ModelStudio Token Plan] qwen3.7-max');
  });

  it('disambiguates same id with distinct badges and preserves order', () => {
    const a = model({
      id: 'qwen3.7-max',
      label: '[ModelStudio Token Plan] qwen3.7-max',
      baseUrl: 'https://cn.example/v1',
      registryBaseUrl: 'https://cn.example/v1',
    });
    const b = model({
      id: 'qwen3.7-max',
      label: '[ModelStudio Coding Plan] qwen3.7-max',
      baseUrl: 'https://coding.example/v1',
      registryBaseUrl: 'https://coding.example/v1',
    });
    const fields = buildAcpModelDisplayFields([
      { model: a, modelId: 'route-a' },
      { model: b, modelId: 'route-b' },
    ]);
    expect(fields.map((f) => f.name)).toEqual([
      'qwen3.7-max · Token Plan',
      'qwen3.7-max · Coding Plan',
    ]);
    expect(fields[0]?.providerLabel).toBe('Token Plan');
    expect(fields[1]?.providerLabel).toBe('Coding Plan');
  });

  it('disambiguates CN vs Intl Token Plan', () => {
    const fields = buildAcpModelDisplayFields([
      {
        model: model({
          id: 'qwen3.7-plus',
          label: '[ModelStudio Token Plan] qwen3.7-plus',
        }),
        modelId: 'a',
      },
      {
        model: model({
          id: 'qwen3.7-plus',
          label: '[ModelStudio Token Plan for Global/Intl] qwen3.7-plus',
        }),
        modelId: 'b',
      },
    ]);
    expect(fields.map((f) => f.name)).toEqual([
      'qwen3.7-plus · Token Plan',
      'qwen3.7-plus · Token Plan (Intl)',
    ]);
  });

  it('falls back for collision with empty parse', () => {
    const fields = buildAcpModelDisplayFields([
      {
        model: model({
          id: 'shared',
          label: 'shared',
          envKey: 'KEY_A',
          baseUrl: 'https://a.example/v1',
          registryBaseUrl: 'https://a.example/v1',
        }),
        modelId: 'route-aaaaaa',
      },
      {
        model: model({
          id: 'shared',
          label: 'shared',
          envKey: 'KEY_B',
          baseUrl: 'https://b.example/v1',
          registryBaseUrl: 'https://b.example/v1',
        }),
        modelId: 'route-bbbbbb',
      },
    ]);
    expect(fields[0]?.name).toBe('shared · KEY_A');
    expect(fields[1]?.name).toBe('shared · KEY_B');
    expect(fields[0]?.name).not.toBe(fields[1]?.name);
  });

  it('uses index suffix when badge names still collide', () => {
    const fields = buildAcpModelDisplayFields([
      {
        model: model({
          id: 'shared',
          label: '[Same Badge] shared',
          envKey: 'SAME',
        }),
        modelId: 'route-aaaaaa',
      },
      {
        model: model({
          id: 'shared',
          label: '[Same Badge] shared',
          envKey: 'SAME',
        }),
        modelId: 'route-bbbbbb',
      },
      {
        model: model({
          id: 'shared',
          label: '[Same Badge] shared',
          envKey: 'SAME',
        }),
        modelId: 'route-cccccc',
      },
    ]);
    expect(fields.map((f) => f.name)).toEqual([
      'shared · Same Badge',
      'shared · 2',
      'shared · 3',
    ]);
    expect(new Set(fields.map((f) => f.name)).size).toBe(3);
  });

  it('uses endpoint snip then modelId slice when envKey missing', () => {
    const fields = buildAcpModelDisplayFields([
      {
        model: model({
          id: 'shared',
          label: 'shared',
          baseUrl: 'https://a.example/path-a',
          registryBaseUrl: 'https://a.example/path-a',
        }),
        modelId: 'opaque-111111',
      },
      {
        model: model({
          id: 'shared',
          label: 'shared',
          baseUrl: 'https://b.example/path-b',
          registryBaseUrl: 'https://b.example/path-b',
        }),
        modelId: 'opaque-222222',
      },
    ]);
    expect(fields[0]?.name).toBe('shared · path-a');
    expect(fields[1]?.name).toBe('shared · path-b');
  });

  it('fills description from badge only when empty', () => {
    const withDesc = buildAcpModelDisplayFields([
      {
        model: model({
          id: 'm1',
          label: '[ModelStudio Token Plan] m1',
          description: 'Keep me',
        }),
        modelId: 'm1(openai)',
      },
    ]);
    expect(withDesc[0]?.description).toBe('Keep me');

    const empty = buildAcpModelDisplayFields([
      {
        model: model({
          id: 'm2',
          label: '[ModelStudio Token Plan] m2',
          description: '',
        }),
        modelId: 'm2(openai)',
      },
    ]);
    expect(empty[0]?.description).toBe('Token Plan');

    const undef = buildAcpModelDisplayFields([
      {
        model: model({
          id: 'm3',
          label: '[ModelStudio Token Plan] m3',
        }),
        modelId: 'm3(openai)',
      },
    ]);
    expect(undef[0]?.description).toBe('Token Plan');
  });

  it('does not mutate input AvailableModel objects', () => {
    const m = model({
      id: 'x',
      label: '[ModelStudio Standard] x',
    });
    const labelBefore = m.label;
    buildAcpModelDisplayFields([{ model: m, modelId: 'x(openai)' }]);
    expect(m.label).toBe(labelBefore);
  });

  it('omits providerLabel when no badge', () => {
    const [fields] = buildAcpModelDisplayFields([
      {
        model: model({ id: 'plain', label: 'plain' }),
        modelId: 'plain(openai)',
      },
    ]);
    expect(fields?.name).toBe('plain');
    expect(fields?.providerLabel).toBeUndefined();
    expect(fields?.legacyName).toBeUndefined();
  });
});
