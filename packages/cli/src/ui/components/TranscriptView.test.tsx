/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { TranscriptView } from './TranscriptView.js';
import type { HistoryItem } from '../types.js';
import { renderWithProviders } from '../../test-utils/render.js';

// The transcript renders thinking blocks in full detail; the inline thinking
// block also installs mouse listeners — stub them out for a deterministic test.
vi.mock('../hooks/useMouseEvents.js', () => ({
  useMouseEvents: vi.fn(),
}));

describe('<TranscriptView />', () => {
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
      <TranscriptView
        items={items}
        onClose={vi.fn()}
        useAlternateScreen={false}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Transcript');
    // Footer hints (Esc/q to close, scroll keys).
    expect(frame).toContain('to close');
    expect(frame).toContain('to scroll');
  });

  it('renders thinking blocks expanded (fullDetail) — full text, not a summary', () => {
    const { lastFrame } = renderWithProviders(
      <TranscriptView
        items={items}
        onClose={vi.fn()}
        useAlternateScreen={false}
      />,
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

  it('does not invoke onClose on its own — close keys are owned by AppContainer', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <TranscriptView
        items={items}
        onClose={onClose}
        useAlternateScreen={false}
      />,
    );
    // The component installs no close-key handler; the global guard in
    // AppContainer owns Esc/q/Ctrl+C/Ctrl+O. onClose must never fire from here.
    expect(onClose).not.toHaveBeenCalled();
  });
});
