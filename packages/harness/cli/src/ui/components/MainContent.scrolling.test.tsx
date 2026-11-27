/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from 'ink';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { waitFor } from '../../test-utils/async.js';
import { MainContent } from './MainContent.js';

// The welcome header's async account/model loading is unrelated to scrolling.
vi.mock('./AppHeader.js', () => ({ AppHeader: () => null }));

describe('alternate screen conversation scrolling', () => {
  it.each(['prompt', 'transcript'] as const)(
    'scrolls %s history with keyboard and terminal wheel input',
    async (conversationScreen) => {
      const result = await renderWithProviders(
        <Box height={10} width={80}>
          <MainContent />
        </Box>,
        {
          settings: createMockSettings({ ui: { useAlternateBuffer: true } }),
          mouseEventsEnabled: true,
          uiState: {
            conversationScreen,
            history: Array.from({ length: 100 }, (_, id) => ({
              id,
              type: 'info' as const,
              text: `History message ${id}`,
            })),
            mainAreaWidth: 80,
            terminalWidth: 80,
            availableTerminalHeight: 10,
            staticAreaMaxItemHeight: 10,
            constrainHeight: false,
            isEditorDialogOpen: false,
            viewedAgentTaskId: undefined,
            mcpAuthNotice: null,
          },
        },
      );

      try {
        const visibleMessages = () =>
          result.lastFrame()?.match(/History message \d+/g);
        await waitFor(() => {
          expect(result.lastFrame()).toContain('History message 99');
        });
        const bottom = visibleMessages();

        await act(async () => result.stdin.write('\x1b[5~'));
        await waitFor(() => {
          expect(visibleMessages()).not.toEqual(bottom);
          expect(result.lastFrame()).not.toContain('History message 99');
        });
        const pageUp = visibleMessages();

        await act(async () => result.stdin.write('\x1b[1;2A'));
        await waitFor(() => expect(visibleMessages()).not.toEqual(pageUp));
        const shiftedUp = visibleMessages();

        await act(async () => result.stdin.write('\x1b[<64;5;5M'.repeat(3)));
        await waitFor(() => expect(visibleMessages()).not.toEqual(shiftedUp));
        const wheelUp = visibleMessages();

        await act(async () => result.stdin.write('\x1b[<65;5;5M'.repeat(3)));
        await waitFor(() => expect(visibleMessages()).not.toEqual(wheelUp));

        await act(async () => result.stdin.write('\x1b[1;5F'));
        await waitFor(() => {
          expect(result.lastFrame()).toContain('History message 99');
        });
      } finally {
        result.unmount();
      }
    },
  );
});
