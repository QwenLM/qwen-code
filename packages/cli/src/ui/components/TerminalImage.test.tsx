/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Static, Text } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import { TerminalOutputProvider } from '../contexts/TerminalOutputContext.js';
import {
  renderTerminalImage,
  type TerminalImageRenderResult,
} from '../utils/terminal-image-renderer.js';
import { TerminalImage } from './TerminalImage.js';

vi.mock('../utils/terminal-image-renderer.js', () => ({
  renderTerminalImage: vi.fn(),
}));

const mockedRenderTerminalImage = vi.mocked(renderTerminalImage);

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
    vi.clearAllMocks();
  });

  it('writes trusted Kitty data and renders its placeholder', async () => {
    const writeRaw = vi.fn();
    const { lastFrame } = renderImage(
      {
        kind: 'kitty',
        sequence: '\x1b_Gpayload\x1b\\',
        placeholder: {
          color: '#00002a',
          imageId: 42,
          lines: ['placeholder'],
        },
      },
      writeRaw,
    );

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

  it('emits direct Kitty placement inline and reserves its rows', () => {
    const sequence = '\x1b_Ga=T,f=100,q=2,C=1,c=4,r=2;payload\x1b\\';
    const { stdout } = renderImage({
      kind: 'kitty-direct',
      sequence,
      rows: 2,
    });

    const directFrame = stdout.frames.find((frame) => frame.includes(sequence));
    expect(Buffer.from(directFrame ?? '').toString('hex')).toBe(
      Buffer.from(`${sequence}\n\n`).toString('hex'),
    );
  });

  it('keeps terminal controls opt-in for ordinary text', () => {
    const sequence = '\x1b_Ga=T,f=100;payload\x1b\\';
    const { stdout } = render(
      <Static items={[sequence]}>
        {(item) => <Text key="plain">{item}safe</Text>}
      </Static>,
    );

    expect(stdout.frames.join('')).not.toContain(sequence);
    expect(stdout.frames.join('')).toContain('safe');
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
    mockedRenderTerminalImage.mockReturnValue({
      kind: 'kitty',
      sequence: '\x1b_Gpayload\x1b\\',
      placeholder: {
        color: '#00002a',
        imageId: 42,
        lines: ['placeholder'],
      },
    });

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
});
