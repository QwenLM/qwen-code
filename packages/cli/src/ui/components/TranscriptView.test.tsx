/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TranscriptView } from './TranscriptView.js';
import type { HistoryItem } from '../types.js';
import { renderWithProviders } from '../../test-utils/render.js';

// The transcript renders thinking blocks in full detail; the inline thinking
// block also installs mouse listeners — stub them out for a deterministic test.
vi.mock('../hooks/useMouseEvents.js', () => ({
  useMouseEvents: vi.fn(),
}));

// Spy on the raw terminal writer so we can assert the alt-screen escapes that
// the default `useAlternateScreen` path emits via the AlternateScreen wrapper.
const writeRaw = vi.fn();
vi.mock('../contexts/TerminalOutputContext.js', () => ({
  useTerminalOutput: () => writeRaw,
  TerminalOutputProvider: ({ children }: { children?: ReactNode }) => children,
}));

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

describe('<TranscriptView />', () => {
  const origIsTTY = process.stdout.isTTY;
  const setTTY = (value: boolean) =>
    Object.defineProperty(process.stdout, 'isTTY', {
      value,
      configurable: true,
    });

  afterEach(() => {
    writeRaw.mockClear();
    setTTY(origIsTTY);
  });

  const items: HistoryItem[] = [
    { id: 1, type: 'user', text: 'hello world' },
    {
      id: 2,
      type: 'gemini_thought',
      text: 'a private reasoning step that is normally collapsed',
    },
    { id: 3, type: 'gemini', text: 'the assistant reply' },
  ];

  it('renders the frozen items with header and footer chrome', () => {
    const { lastFrame } = renderWithProviders(
      <TranscriptView items={items} useAlternateScreen={false} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Transcript');
    // Footer hints (Esc/q to close, scroll keys).
    expect(frame).toContain('to close');
    expect(frame).toContain('to scroll');
  });

  it('renders thinking blocks expanded (fullDetail) — full text, not a summary', () => {
    const { lastFrame } = renderWithProviders(
      <TranscriptView items={items} useAlternateScreen={false} />,
    );
    const frame = lastFrame();
    // The full thought text is shown (fullDetail forces expansion) rather than
    // the collapsed single-line "Thought for …" summary.
    expect(frame).toContain(
      'a private reasoning step that is normally collapsed',
    );
    expect(frame).toContain('hello world');
    expect(frame).toContain('the assistant reply');
  });

  it('enters and exits the alternate screen by default (useAlternateScreen defaults to true)', () => {
    setTTY(true);
    const { unmount } = renderWithProviders(
      <TranscriptView items={items} />,
    );
    // The default path drives AlternateScreen with disabled=false, which writes
    // the enter-alt-screen escape on mount.
    expect(writeRaw).toHaveBeenCalledWith(
      expect.stringContaining(ENTER_ALT_SCREEN),
    );

    writeRaw.mockClear();
    unmount();
    expect(writeRaw).toHaveBeenCalledWith(
      expect.stringContaining(EXIT_ALT_SCREEN),
    );
  });

  it('renders frozen pending items carrying negative ids without key collisions', () => {
    // AppContainer assigns negative ids to the pending snapshot (`id: -(i+1)`),
    // exercising keyExtractor's `tp-` branch alongside the committed `t-` items.
    const withPending: HistoryItem[] = [
      { id: 1, type: 'user', text: 'committed question' },
      { id: -1, type: 'gemini', text: 'streaming pending reply' },
      { id: -2, type: 'gemini_content', text: 'second pending chunk' },
    ];
    const { lastFrame } = renderWithProviders(
      <TranscriptView items={withPending} useAlternateScreen={false} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('committed question');
    expect(frame).toContain('streaming pending reply');
    expect(frame).toContain('second pending chunk');
  });
});
