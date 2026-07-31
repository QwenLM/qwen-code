/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Static } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import { TerminalOutputProvider } from '../contexts/TerminalOutputContext.js';
import { renderTerminalImage } from '../utils/terminal-image-renderer.js';
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

describe('TerminalImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes trusted Kitty data and renders its placeholder', async () => {
    const writeRaw = vi.fn();
    mockedRenderTerminalImage.mockReturnValueOnce({
      kind: 'kitty',
      sequence: '\x1b_Gpayload\x1b\\',
      placeholder: {
        color: '#00002a',
        imageId: 42,
        lines: ['placeholder'],
      },
    });

    const image = {
      type: 'terminal_image' as const,
      filePath: '/workspace/chart.png',
      mimeType: 'image/png' as const,
    };
    const { lastFrame } = render(
      <TerminalOutputProvider value={writeRaw}>
        <Static items={[image]}>
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

    await vi.waitFor(() => {
      expect(writeRaw).toHaveBeenCalledWith('\x1b_Gpayload\x1b\\');
    });
    expect(lastFrame()).toContain('placeholder');
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
});
