// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCopiedFlash } from './useCopiedFlash';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let latest: [boolean, () => void] | undefined;

function Probe({ resetMs }: { resetMs?: number }) {
  latest = useCopiedFlash(resetMs);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
  act(() => {
    root.render(<Probe />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe('useCopiedFlash', () => {
  it('flashes and resets after the delay', () => {
    act(() => latest![1]());
    expect(latest![0]).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(latest![0]).toBe(false);
  });

  it('restarts the reset window on a re-flash', () => {
    act(() => latest![1]());
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => latest![1]());
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // The older reset must not cut the newer feedback short.
    expect(latest![0]).toBe(true);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(latest![0]).toBe(false);
  });

  it('clears the pending reset on unmount', () => {
    act(() => latest![1]());
    act(() => {
      root.unmount();
    });
    // A leaked timer would fire after the test environment is gone and
    // fail the run through the unhandled-error gate.
    expect(vi.getTimerCount()).toBe(0);
  });
});
