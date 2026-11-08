// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useTrajectoryLiveSnapshot } from './trajectory-live-context';
import type { TrajectoryLiveSnapshot } from './trajectory-live-store';

vi.mock('./trajectory-live-store.js', () => {
  throw new Error('Read-only consumers must not load the live store runtime');
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('provides a stable unavailable snapshot without a live provider or runtime', () => {
  const snapshots: TrajectoryLiveSnapshot[] = [];
  function Probe() {
    snapshots.push(useTrajectoryLiveSnapshot());
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<Probe />));
    act(() => root.render(<Probe />));
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toBe(snapshots[0]);
    expect(snapshots[0]).toEqual({
      status: 'unavailable',
      requests: { entries: new Map() },
      tools: { entries: new Map() },
      incomplete: false,
      truncated: false,
    });
  } finally {
    act(() => root.unmount());
  }
});
