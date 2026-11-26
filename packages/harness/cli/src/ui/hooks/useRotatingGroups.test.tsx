/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { render } from '../../test-utils/render.js';
import { Text } from 'ink';
import {
  useRotatingGroups,
  useCrossfadeRotation,
  ROTATING_GROUPS_INTERVAL_MS,
  type UseRotatingGroupsOptions,
  type UseCrossfadeRotationOptions,
} from './useRotatingGroups.js';

const TestComponent = ({
  groupCount,
  options,
  onIndex,
}: {
  groupCount: number;
  options?: UseRotatingGroupsOptions;
  onIndex?: (index: number) => void;
}) => {
  const index = useRotatingGroups(groupCount, options);
  useEffect(() => {
    onIndex?.(index);
  }, [index, onIndex]);
  return <Text>{`index:${index}`}</Text>;
};

const CrossfadeComponent = ({
  groupCount,
  options,
  onIndex,
}: {
  groupCount: number;
  options?: UseCrossfadeRotationOptions;
  onIndex?: (index: number) => void;
}) => {
  const { index } = useCrossfadeRotation(groupCount, options);
  useEffect(() => {
    onIndex?.(index);
  }, [index, onIndex]);
  return <Text>{`index:${index}`}</Text>;
};

const readIndex = (frame: string): number =>
  Number(frame.trim().replace('index:', ''));

describe('useRotatingGroups', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts at index 0', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <TestComponent groupCount={3} />,
    );
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(0);
    unmount();
  });

  it('advances the index after each interval and wraps around', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <TestComponent groupCount={3} />,
    );
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROTATING_GROUPS_INTERVAL_MS + 100);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROTATING_GROUPS_INTERVAL_MS + 100);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROTATING_GROUPS_INTERVAL_MS + 100);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(0);
    unmount();
  });

  it('does not rotate when there is at most one group', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <TestComponent groupCount={1} />,
    );
    await waitUntilReady();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROTATING_GROUPS_INTERVAL_MS * 5);
    });
    expect(readIndex(lastFrame())).toBe(0);
    unmount();
  });

  it('does not rotate when disabled', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <TestComponent groupCount={3} options={{ enabled: false }} />,
    );
    await waitUntilReady();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROTATING_GROUPS_INTERVAL_MS * 3);
    });
    expect(readIndex(lastFrame())).toBe(0);
    unmount();
  });

  it('pauses on the current index without resetting it', async () => {
    let currentIndex = -1;
    const onIndex = (index: number) => {
      currentIndex = index;
    };
    const { rerender, waitUntilReady, unmount } = await render(
      <TestComponent
        groupCount={3}
        options={{ intervalMs: 1000 }}
        onIndex={onIndex}
      />,
    );
    await waitUntilReady();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await waitUntilReady();
    expect(currentIndex).toBe(1);

    await act(async () => {
      rerender(
        <TestComponent
          groupCount={3}
          options={{ intervalMs: 1000, paused: true }}
          onIndex={onIndex}
        />,
      );
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitUntilReady();
    expect(currentIndex).toBe(1);

    await act(async () => {
      rerender(
        <TestComponent
          groupCount={3}
          options={{ intervalMs: 1000 }}
          onIndex={onIndex}
        />,
      );
      await vi.advanceTimersByTimeAsync(1100);
    });
    await waitUntilReady();
    expect(currentIndex).toBe(2);
    unmount();
  });

  it('respects a custom interval shorter than the default', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <TestComponent groupCount={2} options={{ intervalMs: 1000 }} />,
    );
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(0);

    // One custom interval elapses well before the 4000ms default would.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 + 100);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(1);
    unmount();
  });

  it('keeps the index in range when the group count shrinks', async () => {
    const { lastFrame, rerender, waitUntilReady, unmount } = await render(
      <TestComponent groupCount={3} />,
    );
    await waitUntilReady();

    // Advance one interval at a time so each tick is observed reliably.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROTATING_GROUPS_INTERVAL_MS + 100);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROTATING_GROUPS_INTERVAL_MS + 100);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(2);

    await act(async () => {
      rerender(<TestComponent groupCount={2} />);
    });
    await waitUntilReady();
    // index 2 is out of range for 2 groups; the hook clamps it back via modulo.
    expect(readIndex(lastFrame())).toBeLessThan(2);
    expect(readIndex(lastFrame())).toBe(0);
    unmount();
  });

  it('clears the timer on unmount', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { waitUntilReady, unmount } = await render(
      <TestComponent groupCount={3} />,
    );
    await waitUntilReady();
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('useCrossfadeRotation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('holds each group for its own duration when itemDurations matches groupCount', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <CrossfadeComponent
        groupCount={3}
        options={{ animate: false, itemDurations: [1000, 2000, 3000] }}
      />,
    );
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(0);

    // Group 0 dwells 1000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 + 50);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(1);

    // Group 1 dwells 2000ms — not enough time at 1000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 + 50);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(2);

    // Group 2 dwells 3000ms, then wraps to 0.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 + 50);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(0);
    unmount();
  });

  it('falls back to intervalMs when itemDurations length mismatches groupCount', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <CrossfadeComponent
        groupCount={3}
        options={{ animate: false, intervalMs: 1000, itemDurations: [500, 500] }}
      />,
    );
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(0);

    // Mismatched length → every group uses intervalMs (1000ms), not 500ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 50);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500 + 50);
    });
    await waitUntilReady();
    expect(readIndex(lastFrame())).toBe(1);
    unmount();
  });

  it('pauses on the current crossfade index without resetting it', async () => {
    let currentIndex = -1;
    const onIndex = (index: number) => {
      currentIndex = index;
    };
    const { rerender, waitUntilReady, unmount } = await render(
      <CrossfadeComponent
        groupCount={3}
        options={{ animate: false, intervalMs: 1000 }}
        onIndex={onIndex}
      />,
    );
    await waitUntilReady();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await waitUntilReady();
    expect(currentIndex).toBe(1);

    await act(async () => {
      rerender(
        <CrossfadeComponent
          groupCount={3}
          options={{ animate: false, intervalMs: 1000, paused: true }}
          onIndex={onIndex}
        />,
      );
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitUntilReady();
    expect(currentIndex).toBe(1);

    await act(async () => {
      rerender(
        <CrossfadeComponent
          groupCount={3}
          options={{ animate: false, intervalMs: 1000 }}
          onIndex={onIndex}
        />,
      );
      await vi.advanceTimersByTimeAsync(1100);
    });
    await waitUntilReady();
    expect(currentIndex).toBe(2);
    unmount();
  });
});
