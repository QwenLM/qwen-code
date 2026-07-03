/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { ThinkingViewer } from './ThinkingViewer.js';
import { useMouseEvents } from './../hooks/useMouseEvents.js';

// The modal viewer owns the wheel for its own scrolling and renders on the
// alternate screen in non-VP mode (no native scrollback to protect), so it must
// subscribe WITH `bypassVpGate: true`. Mirror of the HistoryItemDisplay test
// that pins the OPPOSITE contract for the click-to-expand handler. The gating
// logic itself lives in useMouseEvents (covered by its own test); here we only
// pin the option ThinkingViewer passes.
vi.mock('./../hooks/useMouseEvents.js', () => ({
  useMouseEvents: vi.fn(),
}));

// Avoid the real terminal-size / keypress / frame-flush wiring — they are not
// part of the contract under test and would otherwise require a TTY + context.
vi.mock('./../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ rows: 24, columns: 80 }),
}));
vi.mock('./../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
vi.mock('./../hooks/use-frame-coalesced-flush.js', () => ({
  useFrameCoalescedFlush: () => ({ schedule: vi.fn(), cancel: vi.fn() }),
}));

describe('ThinkingViewer mouse tracking', () => {
  beforeEach(() => {
    vi.mocked(useMouseEvents).mockClear();
  });

  it('subscribes the wheel handler WITH bypassVpGate (works in non-VP)', () => {
    render(
      <ThinkingViewer
        data={{ text: 'Inspecting the repository', durationMs: 1200 }}
        onClose={() => {}}
        useAlternateScreen={false}
      />,
    );
    expect(vi.mocked(useMouseEvents)).toHaveBeenCalled();
    const opts = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[1];
    expect(opts?.isActive).toBe(true);
    // Must bypass the VP gate, or wheel scrolling in the modal silently breaks
    // in non-VP mode.
    expect(opts?.bypassVpGate).toBe(true);
  });
});
