/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils/render.js';
import { ConnectedReleaseNotesDialog } from './releaseNotesDialog.js';

const mocks = vi.hoisted(() => ({
  entries: [
    { version: '1.0.0', content: 'First notes' },
    { version: '0.9.0', content: 'Second notes' },
  ],
}));

vi.mock('./useChangelog.js', () => ({
  useChangelog: () => ({ entries: mocks.entries, status: 'ready' }),
}));

describe('ConnectedReleaseNotesDialog', () => {
  it('preserves the selected tab across a connected snapshot publish', async () => {
    const rendered = await renderWithProviders(<ConnectedReleaseNotesDialog />);
    await rendered.waitUntilReady();
    act(() => rendered.stdin.write('\t'));
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain('Second notes');

    mocks.entries = [
      { version: '1.0.0', content: 'TRANSLATED_FIRST' },
      { version: '0.9.0', content: 'TRANSLATED_SECOND' },
    ];
    rendered.rerender(<ConnectedReleaseNotesDialog />);
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain('TRANSLATED_SECOND');

    mocks.entries = [{ version: '1.0.0', content: 'TRANSLATED_FIRST' }];
    rendered.rerender(<ConnectedReleaseNotesDialog />);
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain('TRANSLATED_FIRST');
    rendered.unmount();
  });
});
