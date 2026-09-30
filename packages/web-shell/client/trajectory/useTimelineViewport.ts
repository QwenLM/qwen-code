/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import type { TimelineModel } from './buildTimeline';

export interface TimelineViewport {
  start: number;
  end: number;
}

export interface TimelineViewportController {
  viewport: TimelineViewport | undefined;
  currentView: () => { start: number; length: number };
  applyViewport: (next: TimelineViewport | undefined) => void;
}

interface ViewportState {
  viewport: TimelineViewport;
  of: TimelineModel;
}

export function useTimelineViewport(
  model: TimelineModel | undefined,
): TimelineViewportController {
  const [state, setState] = useState<ViewportState>();
  const latest = useRef<ViewportState | undefined>(undefined);

  const currentView = useCallback(() => {
    const current = model;
    const held = latest.current;
    if (!held || held.of !== current) {
      return { start: 0, length: current?.total ?? 0 };
    }
    return {
      start: held.viewport.start,
      length: held.viewport.end - held.viewport.start,
    };
  }, [model]);

  const applyViewport = useCallback(
    (next: TimelineViewport | undefined) => {
      const current = model;
      const value =
        next && current ? { viewport: next, of: current } : undefined;
      // Consecutive native wheel events can arrive before React renders.
      latest.current = value;
      setState(value);
    },
    [model],
  );

  return {
    viewport: state?.of === model ? state?.viewport : undefined,
    currentView,
    applyViewport,
  };
}
