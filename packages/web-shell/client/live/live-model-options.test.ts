/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { liveModelOptions } from './live-model-options';

describe('liveModelOptions', () => {
  it('offers each realtime route by its bare id and display name', () => {
    expect(
      liveModelOptions({
        model: 'omni-realtime',
        models: [
          { id: 'omni-realtime', provider: 'openai', name: 'Omni Realtime' },
          { id: 'omni-flash-realtime', provider: 'openai' },
        ],
      }),
    ).toEqual({
      selected: 'omni-realtime',
      options: [
        { value: 'omni-realtime', label: 'Omni Realtime', route: true },
        {
          value: 'omni-flash-realtime',
          label: 'omni-flash-realtime',
          route: true,
        },
      ],
    });
  });

  it('qualifies an id two providers share, which is ambiguous when bare', () => {
    const { options } = liveModelOptions({
      model: 'openai:omni-realtime',
      models: [
        { id: 'omni-realtime', provider: 'openai' },
        { id: 'omni-realtime', provider: 'dashscope-intl' },
      ],
    });
    expect(options.map((option) => option.value)).toEqual([
      'openai:omni-realtime',
      'dashscope-intl:omni-realtime',
    ]);
    expect(options[1]!.label).toBe('omni-realtime · dashscope-intl');
  });

  it('selects the route a qualified setting names even when the id is unique', () => {
    expect(
      liveModelOptions({
        model: 'openai:omni-realtime',
        models: [{ id: 'omni-realtime', provider: 'openai' }],
      }).selected,
    ).toBe('omni-realtime');
  });

  it('keeps a hand-written model that names no route as the selection', () => {
    expect(
      liveModelOptions({
        model: 'qwen3.5-omni-plus-realtime',
        models: [{ id: 'omni-flash-realtime', provider: 'openai' }],
      }),
    ).toEqual({
      selected: 'qwen3.5-omni-plus-realtime',
      options: [
        {
          value: 'qwen3.5-omni-plus-realtime',
          label: 'qwen3.5-omni-plus-realtime',
          route: false,
        },
        {
          value: 'omni-flash-realtime',
          label: 'omni-flash-realtime',
          route: true,
        },
      ],
    });
  });

  it('works against a daemon that lists no models', () => {
    expect(liveModelOptions({ model: 'm' })).toEqual({
      selected: 'm',
      options: [{ value: 'm', label: 'm', route: false }],
    });
  });
});
