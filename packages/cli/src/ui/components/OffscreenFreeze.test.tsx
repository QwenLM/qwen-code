/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';

const viewportState = vi.hoisted(() => ({
  isAlternateBuffer: false,
  entryVisible: true,
  measuredVisible: true as boolean | null,
}));

vi.mock('../hooks/useAlternateBuffer.js', () => ({
  useAlternateBuffer: () => viewportState.isAlternateBuffer,
}));

vi.mock('../../ink/hooks/use-terminal-viewport.js', () => ({
  useTerminalViewport: () => [
    vi.fn(),
    { isVisible: viewportState.entryVisible },
    () => viewportState.entryVisible,
    () => viewportState.measuredVisible,
  ],
}));

type RenderCounterProps = {
  label: string;
  onRender: () => void;
};

function RenderCounter({ label, onRender }: RenderCounterProps) {
  onRender();
  return <Text>{label}</Text>;
}

describe('OffscreenFreeze', () => {
  beforeEach(() => {
    viewportState.isAlternateBuffer = false;
    viewportState.entryVisible = true;
    viewportState.measuredVisible = true;
  });

  it('reuses the cached element reference while fully offscreen', async () => {
    const onRender = vi.fn();
    const result = await renderWithProviders(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="visible" onRender={onRender} />
      </OffscreenFreeze>,
    );
    await result.waitUntilReady();

    expect(onRender).toHaveBeenCalledTimes(1);
    viewportState.measuredVisible = false;
    result.rerender(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="offscreen update" onRender={onRender} />
      </OffscreenFreeze>,
    );

    expect(onRender).toHaveBeenCalledTimes(1);
    result.unmount();
  });

  it('picks up the latest children after becoming visible again', async () => {
    const onRender = vi.fn();
    const result = await renderWithProviders(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="first" onRender={onRender} />
      </OffscreenFreeze>,
    );
    await result.waitUntilReady();

    viewportState.measuredVisible = false;
    result.rerender(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="hidden" onRender={onRender} />
      </OffscreenFreeze>,
    );
    viewportState.measuredVisible = true;
    result.rerender(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="restored" onRender={onRender} />
      </OffscreenFreeze>,
    );
    await result.waitUntilReady();

    expect(onRender).toHaveBeenCalledTimes(2);
    expect(result.lastFrame()).toContain('restored');
    result.unmount();
  });

  it('uses the cached layout-effect entry when immediate measurement is unavailable', async () => {
    const onRender = vi.fn();
    const result = await renderWithProviders(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="first" onRender={onRender} />
      </OffscreenFreeze>,
    );
    await result.waitUntilReady();

    viewportState.measuredVisible = null;
    viewportState.entryVisible = false;
    result.rerender(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="fallback update" onRender={onRender} />
      </OffscreenFreeze>,
    );

    expect(onRender).toHaveBeenCalledTimes(1);
    result.unmount();
  });

  it('bypasses freezing when alternate-buffer rendering owns scrolling', async () => {
    const onRender = vi.fn();
    const result = await renderWithProviders(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="first" onRender={onRender} />
      </OffscreenFreeze>,
    );
    await result.waitUntilReady();

    viewportState.measuredVisible = false;
    viewportState.isAlternateBuffer = true;
    result.rerender(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="alternate update" onRender={onRender} />
      </OffscreenFreeze>,
    );
    await result.waitUntilReady();

    expect(onRender).toHaveBeenCalledTimes(2);
    expect(result.lastFrame()).toContain('alternate update');
    result.unmount();
  });

  it('refreshes a frozen snapshot when its layout key changes', async () => {
    const onRender = vi.fn();
    const result = await renderWithProviders(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="wide" onRender={onRender} />
      </OffscreenFreeze>,
    );
    await result.waitUntilReady();

    viewportState.measuredVisible = false;
    result.rerender(
      <OffscreenFreeze layoutKey={80}>
        <RenderCounter label="same width" onRender={onRender} />
      </OffscreenFreeze>,
    );
    expect(onRender).toHaveBeenCalledTimes(1);

    result.rerender(
      <OffscreenFreeze layoutKey={60}>
        <RenderCounter label="narrow" onRender={onRender} />
      </OffscreenFreeze>,
    );
    await result.waitUntilReady();

    expect(onRender).toHaveBeenCalledTimes(2);
    expect(result.lastFrame()).toContain('narrow');
    result.unmount();
  });

  it('does not add visible rows around a multi-line child', async () => {
    const result = await renderWithProviders(
      <OffscreenFreeze layoutKey={80}>
        <Box flexDirection="column">
          <Text>line one</Text>
          <Text>line two</Text>
        </Box>
      </OffscreenFreeze>,
    );
    await result.waitUntilReady();

    expect(result.lastFrame().trimEnd()).toBe('line one\nline two');
    result.unmount();
  });
});
