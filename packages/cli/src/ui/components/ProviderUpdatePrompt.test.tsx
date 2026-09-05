/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { ProviderUpdatePrompt } from './ProviderUpdatePrompt.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseKeypress = vi.mocked(useKeypress);

describe('ProviderUpdatePrompt', () => {
  beforeEach(() => {
    mockedUseKeypress.mockClear();
  });

  it('does not promise an automatic model switch', () => {
    const { lastFrame } = renderWithProviders(
      <ProviderUpdatePrompt
        entries={[
          {
            providerLabel: 'Coding Plan',
            diff: {
              added: ['new-model'],
              removed: ['removed-model'],
              currentModelAffected: true,
            },
          },
        ]}
        onConfirm={vi.fn()}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Your selected model is being removed');
    expect(frame).toContain('choose a new one with /model');
    expect(frame).not.toContain('will switch');
    expect(frame).not.toContain('undefined');
  });

  it('does not show the removed-model warning when the selected model is unaffected', () => {
    const { lastFrame } = renderWithProviders(
      <ProviderUpdatePrompt
        entries={[
          {
            providerLabel: 'Coding Plan',
            diff: {
              added: ['new-model'],
              removed: [],
              currentModelAffected: false,
            },
          },
        ]}
        onConfirm={vi.fn()}
      />,
    );

    expect(lastFrame() ?? '').not.toContain(
      'Your selected model is being removed',
    );
  });
});
