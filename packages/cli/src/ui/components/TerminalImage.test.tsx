/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Static, useIsScreenReaderEnabled } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import { TerminalOutputProvider } from '../contexts/TerminalOutputContext.js';
import {
  prepareInlineTerminalImage,
  renderTerminalImage,
  type TerminalImageRenderResult,
} from '../utils/terminal-image-renderer.js';
import { TerminalImage } from './TerminalImage.js';

const { writtenKeys } = vi.hoisted(() => ({ writtenKeys: new Set<string>() }));

vi.mock('../utils/terminal-image-renderer.js', () => ({
  prepareInlineTerminalImage: vi.fn(),
  renderTerminalImage: vi.fn(),
  wasKittyImageWritten: vi.fn((key: string) => writtenKeys.has(key)),
  markKittyImageWritten: vi.fn((key: string) => {
    writtenKeys.add(key);
  }),
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useIsScreenReaderEnabled: vi.fn(() => false),
  };
});

const mockedRenderTerminalImage = vi.mocked(renderTerminalImage);
const mockedPrepareInlineTerminalImage = vi.mocked(prepareInlineTerminalImage);

function configWithWorkspaceResult(isWithinWorkspace: boolean): Config {
  return {
    getWorkspaceContext: () => ({
      isPathWithinWorkspace: () => isWithinWorkspace,
    }),
  } as unknown as Config;
}

const IMAGE = {
  type: 'terminal_image' as const,
  filePath: '/workspace/chart.png',
  mimeType: 'image/png' as const,
};

const INLINE_IMAGE = {
  data: 'iVBORw0KGgo=',
  mimeType: 'image/png',
};

const KITTY_RESULT: TerminalImageRenderResult = {
  kind: 'kitty',
  key: 'kitty-payload',
  sequence: '\x1b_Gpayload\x1b\\',
  placeholder: {
    color: '#00002a',
    imageId: 42,
    lines: ['placeholder'],
  },
};

function renderImage(
  result: TerminalImageRenderResult,
  writeRaw: (...args: unknown[]) => void = vi.fn(),
) {
  mockedRenderTerminalImage.mockReturnValueOnce(result);
  return render(
    <TerminalOutputProvider value={writeRaw}>
      <Static items={[IMAGE]}>
        {(item) => (
          <TerminalImage
            data={item}
            config={configWithWorkspaceResult(true)}
            contentWidth={80}
            availableTerminalHeight={20}
          />
        )}
      </Static>
    </TerminalOutputProvider>,
  );
}

describe('TerminalImage', () => {
  beforeEach(() => {
    writtenKeys.clear();
    vi.clearAllMocks();
    vi.mocked(useIsScreenReaderEnabled).mockReturnValue(false);
  });

  it('writes trusted Kitty data and renders its placeholder', async () => {
    const writeRaw = vi.fn();
    const { lastFrame } = renderImage(KITTY_RESULT, writeRaw);

    await vi.waitFor(() => {
      expect(writeRaw).toHaveBeenCalledWith('\x1b_Gpayload\x1b\\');
    });
    expect(lastFrame()).toContain('placeholder');
  });

  it('renders chafa ansi output', () => {
    const { lastFrame } = renderImage({ kind: 'ansi', lines: ['▀▀', '▄▄'] });

    expect(lastFrame()).toContain('▀▀');
    expect(lastFrame()).toContain('▄▄');
  });

  it('shows a readable fallback when no renderer is available', () => {
    const { lastFrame } = renderImage({
      kind: 'unavailable',
      reason: 'chafa is not installed',
    });

    expect(lastFrame()).toContain('chafa is not installed');
    expect(lastFrame()).toContain('chart.png');
  });

  it('refuses restored paths outside the current workspace', () => {
    const { lastFrame } = render(
      <TerminalImage
        data={{
          type: 'terminal_image',
          filePath: '/outside/chart.png',
          mimeType: 'image/png',
        }}
        config={configWithWorkspaceResult(false)}
        contentWidth={80}
      />,
    );

    expect(lastFrame()).toContain('outside the current workspace');
    expect(mockedRenderTerminalImage).not.toHaveBeenCalled();
  });

  it('does not re-emit the Kitty sequence when the emit effect re-runs', async () => {
    mockedRenderTerminalImage.mockReturnValue(KITTY_RESULT);

    const renderWith = (writer: (...args: unknown[]) => void) => (
      <TerminalOutputProvider value={writer}>
        <TerminalImage
          data={IMAGE}
          config={configWithWorkspaceResult(true)}
          contentWidth={80}
          availableTerminalHeight={20}
        />
      </TerminalOutputProvider>
    );

    const firstWriteRaw = vi.fn();
    const { rerender } = render(renderWith(firstWriteRaw));

    await vi.waitFor(() => {
      expect(firstWriteRaw).toHaveBeenCalledWith('\x1b_Gpayload\x1b\\');
    });
    expect(firstWriteRaw).toHaveBeenCalledTimes(1);

    const secondWriteRaw = vi.fn();
    rerender(renderWith(secondWriteRaw));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(secondWriteRaw).not.toHaveBeenCalled();
    expect(firstWriteRaw).toHaveBeenCalledTimes(1);
  });

  it('does not re-transmit the Kitty payload when the image remounts', async () => {
    mockedRenderTerminalImage.mockReturnValue(KITTY_RESULT);

    const renderWith = (writer: (...args: unknown[]) => void) => (
      <TerminalOutputProvider value={writer}>
        <TerminalImage
          data={IMAGE}
          config={configWithWorkspaceResult(true)}
          contentWidth={80}
          availableTerminalHeight={20}
        />
      </TerminalOutputProvider>
    );

    const firstWriteRaw = vi.fn();
    const first = render(renderWith(firstWriteRaw));
    await vi.waitFor(() => {
      expect(firstWriteRaw).toHaveBeenCalledWith('\x1b_Gpayload\x1b\\');
    });
    first.unmount();

    // A fresh mount (live row -> Static row, or a resize) previously
    // re-transmitted the whole payload even though the terminal still holds it.
    const secondWriteRaw = vi.fn();
    const second = render(renderWith(secondWriteRaw));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(secondWriteRaw).not.toHaveBeenCalled();
    second.unmount();
  });

  it('renders inline image data through the shared renderer', async () => {
    const writeRaw = vi.fn();
    mockedPrepareInlineTerminalImage.mockReturnValue({
      fallbackText: '[image: 1x1 png]',
      result: KITTY_RESULT,
    });

    const { lastFrame } = render(
      <TerminalOutputProvider value={writeRaw}>
        <TerminalImage image={INLINE_IMAGE} contentWidth={80} />
      </TerminalOutputProvider>,
    );

    await vi.waitFor(() => {
      expect(writeRaw).toHaveBeenCalledWith(KITTY_RESULT.sequence);
    });
    expect(lastFrame()).toContain('placeholder');
    expect(mockedPrepareInlineTerminalImage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: INLINE_IMAGE.data,
        mimeType: INLINE_IMAGE.mimeType,
        disabled: false,
      }),
    );
  });

  it('explains why an inline image renderer is unavailable', () => {
    mockedPrepareInlineTerminalImage.mockReturnValue({
      fallbackText: '[image: 1x1 png]',
      result: {
        kind: 'unavailable',
        reason: 'chafa is not installed',
      },
    });

    const { lastFrame } = render(
      <TerminalImage image={INLINE_IMAGE} contentWidth={80} />,
    );

    expect(lastFrame()).toContain('[image: 1x1 png]');
    expect(lastFrame()).toContain('chafa is not installed');
  });

  it('uses the deterministic inline placeholder for screen readers', () => {
    vi.mocked(useIsScreenReaderEnabled).mockReturnValue(true);
    mockedPrepareInlineTerminalImage.mockReturnValue({
      fallbackText: '[image: 1x1 png]',
      result: null,
    });

    const { lastFrame } = render(
      <TerminalImage image={INLINE_IMAGE} contentWidth={80} />,
    );

    expect(lastFrame()).toContain('[image: 1x1 png]');
    expect(mockedPrepareInlineTerminalImage).toHaveBeenCalledWith(
      expect.objectContaining({ disabled: true }),
    );
  });
});
