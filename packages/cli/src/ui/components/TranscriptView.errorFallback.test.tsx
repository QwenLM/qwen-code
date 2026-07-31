/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HistoryItem } from '../types.js';
import { renderWithProviders } from '../../test-utils/render.js';

// Force every item render to throw so the transcript's ErrorBoundary +
// `errorFallback` recovery path is exercised (the fullDetail render path hits
// code the normal view never does, so a throw here must show the fallback
// instead of crashing the CLI). Isolated in its own file so the throwing mock
// doesn't affect the main TranscriptView render tests.
vi.mock('./HistoryItemDisplay.js', () => ({
  HistoryItemDisplay: () => {
    throw new Error('malformed history item');
  },
}));

vi.mock('../hooks/useMouseEvents.js', () => ({
  useMouseEvents: vi.fn(),
}));

vi.mock('../contexts/TerminalOutputContext.js', () => ({
  useTerminalOutput: () => vi.fn(),
  TerminalOutputProvider: ({ children }: { children?: ReactNode }) => children,
}));

import { TranscriptView } from './TranscriptView.js';

describe('<TranscriptView /> error fallback', () => {
  // React logs the caught render error to console.error; silence it.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('shows the recovery fallback (not a crash) when an item render throws', () => {
    const items: HistoryItem[] = [{ id: 1, type: 'user', text: 'anything' }];
    const { lastFrame } = renderWithProviders(
      <TranscriptView items={items} useAlternateScreen={false} />,
    );
    const frame = lastFrame() ?? '';
    // The ErrorBoundary's `errorFallback` renders its title + the Esc/q hint
    // instead of letting the throw propagate and take the process down.
    expect(frame).toContain('Failed to render transcript.');
    expect(frame).toContain('to close');
  });
});
