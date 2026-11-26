/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { QueryParams } from '../core/agent-loop.js';
import type { PromptBuildResult, SystemPrompt } from './types.js';
import {
  appendSystemPromptText,
  systemPromptFromText,
  systemPromptToText,
} from './system-prompt.js';

describe('system prompt representation', () => {
  it('rejects strings at the model request boundary', () => {
    expectTypeOf<string>().not.toMatchTypeOf<SystemPrompt>();
    expectTypeOf<QueryParams['systemPrompt']>().toEqualTypeOf<
      SystemPrompt | undefined
    >();
    expectTypeOf<PromptBuildResult>().not.toHaveProperty('text');
  });

  it('preserves authored whitespace and represents an empty prompt without blocks', () => {
    expect(systemPromptFromText('')).toEqual([]);
    expect(systemPromptFromText('  prompt\n')).toEqual([
      { type: 'text', text: '  prompt\n' },
    ]);
  });

  it('projects text without altering block boundaries', () => {
    const blocks = [
      { type: 'text', text: 'stable' },
      { type: 'text', text: 'dynamic' },
    ] as const;
    expect(systemPromptToText(blocks)).toBe('stable\n\ndynamic');
    expect(blocks).toHaveLength(2);
  });

  it('appends instructions without flattening or mutating the parent', () => {
    const parent = Object.freeze([
      Object.freeze({ type: 'text' as const, text: 'stable' }),
      Object.freeze({ type: 'text' as const, text: 'dynamic' }),
    ]);
    expect(appendSystemPromptText(parent, 'suffix')).toEqual([
      { type: 'text', text: 'stable' },
      { type: 'text', text: 'dynamic\n\nsuffix' },
    ]);
    expect(parent[1].text).toBe('dynamic');
    expect(appendSystemPromptText(parent, '')).toBe(parent);
    expect(appendSystemPromptText([], 'suffix')).toEqual(
      systemPromptFromText('suffix'),
    );
  });
});
