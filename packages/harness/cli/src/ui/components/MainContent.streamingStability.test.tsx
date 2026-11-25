/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createMockSettings } from '../../test-utils/settings.js';
import { makeFakeConfig } from '@qwen-code/core';
import { MainContent } from './MainContent.js';
import { createTuiFixture } from '../../test-utils/tuiFixture.js';
const { renderWithProviders } = createTuiFixture();
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from 'ink';
import { act, useState } from 'react';
import { useAlternateBuffer } from '../hooks/useAlternateBuffer.js';
import {
  UIStateContext,
  useUIState,
  type UIState,
} from '../contexts/UIStateContext.js';
import {
  PendingHistoryContext,
  usePendingHistory,
} from '../contexts/PendingHistoryContext.js';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import type * as historyProjection from '../utils/historyProjection.js';

// Counts renders of static history items so a test can prove streaming
// pending-item updates do not re-render the mounted history.
const historyItemRenderCounter = vi.hoisted(() => ({ renders: 0 }));

vi.mock('./HistoryItemDisplay.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./HistoryItemDisplay.js')>();
  return {
    ...actual,
    HistoryItemDisplay: ({ item }: { item: HistoryItem }) => {
      // Only count renders of static history items; the pending streaming
      // item legitimately re-renders per token batch.
      if (
        item.type === 'user' ||
        (item.type === 'gemini' && item.text.startsWith('answer '))
      ) {
        historyItemRenderCounter.renders++;
      }
      return <Text>{`item-${item.id}`}</Text>;
    },
  };
});

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useApp: () => ({ exit: vi.fn(), rerender: vi.fn() }),
  };
});

const mockUseSettings = vi.fn().mockReturnValue(
  createMockSettings({
    ui: { inlineThinkingMode: 'off' },
  }),
);

vi.mock('../contexts/SettingsContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/SettingsContext.js')>();
  return {
    ...actual,
    useSettings: () => mockUseSettings(),
  };
});

vi.mock('../contexts/AppContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/AppContext.js')>();
  return {
    ...actual,
    useAppContext: () => ({
      version: '1.0.0',
    }),
  };
});

vi.mock('../hooks/useAlternateBuffer.js', () => ({
  useAlternateBuffer: vi.fn(),
}));

// Spy on the projection helper without changing behavior, so the test can
// assert the static-history projection is NOT recomputed when only the
// streaming pending items change. Calls whose input is the full static
// history (many items) are counted separately from the small pending-item
// projections that legitimately re-run per token batch.
const projectionSpy = vi.hoisted(() => ({
  staticHistoryProjectionCalls: 0,
}));
vi.mock('../utils/historyProjection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/historyProjection.js')>();
  return {
    ...actual,
    projectHistoryForDisplay: (
      ...args: Parameters<typeof historyProjection.projectHistoryForDisplay>
    ) => {
      if (args[0].length > 10) {
        projectionSpy.staticHistoryProjectionCalls++;
      }
      return actual.projectHistoryForDisplay(...args);
    },
  };
});

// Long-session-ish static history with stable item references.
const staticHistory: HistoryItem[] = Array.from({ length: 120 }, (_, i) => ({
  id: i + 1,
  type: i % 2 === 0 ? ('user' as const) : ('gemini' as const),
  text: i % 2 === 0 ? `prompt ${i}` : `answer ${i}`,
}));

const baseUiState = {
  history: staticHistory,
  mcpAuthNotice: null,
  pendingHistoryItems: [] as HistoryItemWithoutId[],
  mainAreaWidth: 80,
  staticAreaMaxItemHeight: 20,
  availableTerminalHeight: 24,
  slashCommands: [],
  constrainHeight: false,
  thought: null,
  isEditorDialogOpen: false,
  activeShellId: undefined,
  conversationKey: 0,
  conversationScreen: 'prompt' as const,
  cleanUiDetailsVisible: true,
  terminalWidth: 100,
  isConfigInitialized: true,
};

describe('MainContent streaming pending-item stability', () => {
  beforeEach(() => {
    vi.mocked(useAlternateBuffer).mockReturnValue(false);
    historyItemRenderCounter.renders = 0;
    projectionSpy.staticHistoryProjectionCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not rebuild the static-history projection on pending item updates', async () => {
    let setPendingItems: ((items: HistoryItemWithoutId[]) => void) | undefined;

    const Harness = () => {
      const outerState = useUIState();
      const outerPending = usePendingHistory();
      const [pendingHistoryItems, setPendingHistoryItems] = useState<
        HistoryItemWithoutId[]
      >([]);
      setPendingItems = setPendingHistoryItems;
      return (
        <UIStateContext.Provider value={{ ...outerState, ...baseUiState }}>
          <PendingHistoryContext.Provider
            value={{ ...outerPending, pendingHistoryItems }}
          >
            <MainContent />
          </PendingHistoryContext.Provider>
        </UIStateContext.Provider>
      );
    };

    const config = makeFakeConfig();
    const { unmount } = await renderWithProviders(<Harness />, {
      uiState: baseUiState as Partial<UIState>,
      config,
    });

    // Let the initial mount settle (history window layout effects etc).
    await act(async () => {});

    const rendersAfterMount = historyItemRenderCounter.renders;
    const projectionsAfterMount = projectionSpy.staticHistoryProjectionCalls;
    expect(rendersAfterMount).toBeGreaterThan(0);
    expect(projectionsAfterMount).toBeGreaterThan(0);

    // Simulate streamed token batches: only the pending items change.
    const setPendingItemsSafe = setPendingItems!;
    await act(async () => {
      setPendingItemsSafe([{ type: 'gemini', text: 'partial to' }]);
    });
    await act(async () => {
      setPendingItemsSafe([{ type: 'gemini', text: 'partial token' }]);
    });
    await act(async () => {
      setPendingItemsSafe([{ type: 'gemini', text: 'partial tokens.' }]);
    });

    // The static-history projection and the mounted history items must be
    // untouched by pending churn — before the fix every token batch
    // re-projected and re-created elements for the entire history.
    expect(projectionSpy.staticHistoryProjectionCalls).toBe(
      projectionsAfterMount,
    );
    expect(historyItemRenderCounter.renders).toBe(rendersAfterMount);

    unmount();
  });
});
