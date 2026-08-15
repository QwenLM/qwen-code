/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { MultiSelect } from './MultiSelect.js';

describe('MultiSelect', () => {
  it('wraps labels by default so shared prefixes stay distinguishable', () => {
    const ui = (
      <KeypressProvider kittyProtocolEnabled={false}>
        <MultiSelect
          items={[
            {
              key: 'qwen3-max',
              value: 'qwen3-max',
              label: '[openai] qwen3-max',
            },
            {
              key: 'qwen3-max-preview',
              value: 'qwen3-max-preview',
              label: '[openai] qwen3-max-preview',
            },
          ]}
          onConfirm={vi.fn()}
        />
      </KeypressProvider>
    );
    const result = render(ui);
    Object.defineProperty(result.stdout, 'columns', { value: 28 });
    result.rerender(ui);

    expect(result.lastFrame()).toContain('qwen3-max-preview');
    expect(result.lastFrame()).not.toContain('…');
  });
});
