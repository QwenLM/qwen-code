/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { ProviderUpdatePrompt } from './ProviderUpdatePrompt.js';
import type { ProviderUpdateEntry } from '../hooks/useProviderUpdates.js';

describe('ProviderUpdatePrompt', () => {
  it('renders distinguishable sections for same-provider endpoint updates', () => {
    // Two stale Kimi endpoints produce entries with an identical
    // providerLabel; the sections must stay unique (metadataKey keys) and
    // individually labelled (endpointLabel suffix).
    const entries: ProviderUpdateEntry[] = [
      {
        metadataKey: 'kimi--coding-plan',
        providerLabel: 'Kimi',
        endpointLabel: 'Coding Plan',
        diff: {
          added: ['kimi-for-coding-highspeed'],
          removed: [],
          currentModelAffected: false,
        },
      },
      {
        metadataKey: 'kimi--api-international',
        providerLabel: 'Kimi',
        endpointLabel: 'API Key (International)',
        diff: { added: [], removed: [], currentModelAffected: false },
      },
    ];

    const { lastFrame } = renderWithProviders(
      <ProviderUpdatePrompt entries={entries} onConfirm={vi.fn()} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Kimi · Coding Plan');
    expect(frame).toContain('Kimi · API Key (International)');
    expect(frame).toContain('+ kimi-for-coding-highspeed');
  });

  it('renders the plain provider label when there is no endpoint', () => {
    const { lastFrame } = renderWithProviders(
      <ProviderUpdatePrompt
        entries={[
          {
            metadataKey: 'coding-plan',
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

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Coding Plan');
    expect(frame).not.toContain('Coding Plan · ');
  });
});
