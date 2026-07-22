/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  orderPromptFragments,
  renderPromptFragments,
  type PromptFragment,
} from './prompt-fragments.js';

function fragment(
  marker: string,
  tier: PromptFragment['tier'],
  content: string | undefined,
): PromptFragment {
  return { marker, role: 'system', tier, content };
}

describe('prompt fragments', () => {
  it('renders stable, context, and volatile tiers in cache order', () => {
    const result = renderPromptFragments([
      fragment('append', 'volatile', 'Append'),
      fragment('memory', 'context', 'Memory'),
      fragment('base', 'stable', 'Base'),
      fragment('git', 'context', 'Git'),
    ]);

    expect(result).toBe(
      ['Base', ['Memory', 'Git'].join('\n\n'), 'Append'].join('\n\n---\n\n'),
    );
  });

  it('omits blank fragments and preserves order within a tier', () => {
    const ordered = orderPromptFragments([
      fragment('second', 'context', 'Second'),
      fragment('blank', 'stable', '  '),
      fragment('first', 'context', 'First'),
      fragment('missing', 'volatile', undefined),
    ]);

    expect(ordered.map((item) => item.marker)).toEqual(['second', 'first']);
  });

  it('rejects rendering fragments with mixed wire roles', () => {
    expect(() =>
      renderPromptFragments([
        fragment('base', 'stable', 'Base'),
        {
          marker: 'startup',
          role: 'user',
          tier: 'context',
          content: 'Startup',
        },
      ]),
    ).toThrow('different roles');
  });
});
