/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { diffCommand } from './diffCommand.js';
import {
  fetchGitDiffFiles,
  fetchGitDiffString,
  isGitRepository,
} from '../utils/gitDiff.js';

vi.mock('../utils/gitDiff.js', () => ({
  isGitRepository: vi.fn().mockResolvedValue(true),
  fetchGitDiffFiles: vi.fn(),
  fetchGitDiffString: vi.fn(() => ({ diffString: '', truncated: false })),
  MAX_LINES_PER_FILE: 400,
}));

describe('/diff preview navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchGitDiffFiles).mockReturnValue(
      [
        'other.ts',
        ...Array.from({ length: 12 }, (_, i) => `review-${i}.ts`),
      ].map((path) => ({
        path,
        linesAdded: 1,
        linesRemoved: 1,
        isBinary: false,
        isNewFile: false,
        isUntracked: false,
      })),
    );
  });

  it('can close while repository detection is pending without starting a late diff', async () => {
    let resolveProbe!: (value: boolean) => void;
    vi.mocked(isGitRepository).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      }),
    );
    const context = createMockCommandContext({
      ui: { removeComponent: vi.fn() },
    });
    const result = await diffCommand.action!(context, '');
    if (result?.type !== 'custom_dialog') throw new Error('Expected dialog');
    const view = await renderWithProviders(result.component as ReactElement);
    try {
      expect(fetchGitDiffFiles).not.toHaveBeenCalled();
      expect(view.lastFrame()).toContain('Checking repository');
      view.stdin.write('\u001B');
      await waitFor(() =>
        expect(context.ui.removeComponent).toHaveBeenCalled(),
      );
      await view.rerender(<></>);
      await act(async () => resolveProbe(true));
      expect(fetchGitDiffFiles).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it.each([
    { query: '', down: 3, expected: 'review-2.ts' },
    { query: 'review', down: 9, expected: 'review-9.ts' },
  ])(
    'restores selection and search after preview: $query',
    async ({ query, down, expected }) => {
      const context = createMockCommandContext({
        ui: {
          setFullScreenComponent: vi.fn(),
          removeFullScreenComponent: vi.fn(),
          removeComponent: vi.fn(),
        },
      });
      const result = await diffCommand.action!(context, '');
      if (result?.type !== 'custom_dialog') throw new Error('Expected dialog');
      const browser = result.component as ReactElement;
      let view!: Awaited<ReturnType<typeof renderWithProviders>>;
      await act(async () => {
        view = await renderWithProviders(browser);
      });
      const press = async (key: string) => {
        await act(async () => {
          view.stdin.write(key);
        });
        await view.waitUntilReady();
      };
      try {
        await view.waitUntilReady();
        if (query) await press(query);
        for (let i = 0; i < down; i++) await press('\u001B[B');
        for (let round = 0; round < 2; round++) {
          await press('\r');
          await waitFor(() =>
            expect(context.ui.setFullScreenComponent).toHaveBeenCalledTimes(
              round + 1,
            ),
          );
          const preview = vi.mocked(context.ui.setFullScreenComponent).mock
            .calls[round][0] as ReactElement;
          await view.rerender(preview);
          await view.waitUntilReady();
          expect(fetchGitDiffString).toHaveBeenLastCalledWith(expected);
          await press('\u001B');
          await waitFor(() =>
            expect(context.ui.removeFullScreenComponent).toHaveBeenCalledTimes(
              round + 1,
            ),
          );
          await view.rerender(browser);
          await view.waitUntilReady();
          expect(fetchGitDiffFiles).toHaveBeenCalledTimes(1);
          if (query) expect(view.lastFrame()).not.toContain('other.ts');
        }
        if (query) {
          // Inspect the top of the returned list so an unfiltered first row
          // cannot be hidden outside the scrolling window.
          for (let i = 0; i < down + 1; i++) await press('\u001B[A');
          expect(view.lastFrame()).toContain('review-0.ts');
          expect(view.lastFrame()).not.toContain('other.ts');
        }
        // Closing and invoking the command again starts a fresh review session.
        await press('\u001B');
        await waitFor(() =>
          expect(context.ui.removeComponent).toHaveBeenCalled(),
        );
        await view.rerender(<></>);
        const fresh = await diffCommand.action!(context, '');
        if (fresh?.type !== 'custom_dialog') throw new Error('Expected dialog');
        await act(async () => {
          view.rerender(fresh.component as ReactElement);
        });
        await view.waitUntilReady();
        expect(fetchGitDiffFiles).toHaveBeenCalledTimes(2);
        expect(view.lastFrame()).toContain('other.ts');
        await press('\r');
        const preview = vi
          .mocked(context.ui.setFullScreenComponent)
          .mock.calls.at(-1)![0] as ReactElement;
        await view.rerender(preview);
        await view.waitUntilReady();
        expect(fetchGitDiffString).toHaveBeenLastCalledWith('other.ts');
      } finally {
        view.unmount();
      }
    },
  );
});
