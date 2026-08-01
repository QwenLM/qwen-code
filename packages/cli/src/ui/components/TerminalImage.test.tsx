/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DOMElement } from 'ink';
import { useIsScreenReaderEnabled } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutputProvider } from '../contexts/TerminalOutputContext.js';
import { VirtualViewportContext } from '../contexts/VirtualViewportContext.js';
import { calculateITerm2Placement, TerminalImage } from './TerminalImage.js';

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useIsScreenReaderEnabled: vi.fn(() => false),
  };
});

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const originalRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
const TERMINAL_ENV_KEYS = [
  'QWEN_CODE_DISABLE_TERMINAL_IMAGES',
  'QWEN_CODE_TERMINAL_IMAGE_PROTOCOL',
  'TMUX',
  'STY',
  'SSH_TTY',
  'SSH_CLIENT',
  'SSH_CONNECTION',
] as const;
const originalTerminalEnv = new Map(
  TERMINAL_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  });
}

function setStdoutRows(value: number): void {
  Object.defineProperty(process.stdout, 'rows', {
    configurable: true,
    value,
  });
  process.stdout.emit('resize');
}

beforeEach(() => {
  for (const key of TERMINAL_ENV_KEYS) {
    delete process.env[key];
  }
  setStdoutIsTTY(true);
  setStdoutRows(24);
  vi.mocked(useIsScreenReaderEnabled).mockReturnValue(false);
});

afterEach(() => {
  if (originalIsTTY) {
    Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
  } else {
    delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
  if (originalRows) {
    Object.defineProperty(process.stdout, 'rows', originalRows);
  } else {
    delete (process.stdout as { rows?: number }).rows;
  }
  for (const key of TERMINAL_ENV_KEYS) {
    const originalValue = originalTerminalEnv.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

describe('<TerminalImage />', () => {
  it('writes Kitty image data through raw output and renders its placeholder', async () => {
    process.env['QWEN_CODE_TERMINAL_IMAGE_PROTOCOL'] = 'kitty';
    const writeRaw = vi.fn();
    const { lastFrame } = render(
      <TerminalOutputProvider value={writeRaw}>
        <TerminalImage
          image={{ data: PNG_1X1_BASE64, mimeType: 'image/png' }}
          contentWidth={20}
          availableTerminalHeight={4}
        />
      </TerminalOutputProvider>,
    );

    await vi.waitFor(() => expect(writeRaw).toHaveBeenCalledOnce());
    expect(writeRaw.mock.calls[0]?.[0]).toContain('\u001b_Ga=T,f=100');
    expect(lastFrame()?.split('\n')).toHaveLength(4);
  });

  it('cancels a delayed Kitty write when the image unmounts', async () => {
    process.env['QWEN_CODE_TERMINAL_IMAGE_PROTOCOL'] = 'kitty';
    const writeRaw = vi.fn();
    const view = render(
      <TerminalOutputProvider value={writeRaw}>
        <TerminalImage
          image={{ data: PNG_1X1_BASE64, mimeType: 'image/png' }}
          contentWidth={20}
        />
      </TerminalOutputProvider>,
    );

    view.unmount();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writeRaw).not.toHaveBeenCalled();
  });

  it('writes iTerm2 data at the measured cursor location', async () => {
    process.env['QWEN_CODE_TERMINAL_IMAGE_PROTOCOL'] = 'iterm2';
    const writeRaw = vi.fn();
    render(
      <VirtualViewportContext.Provider value={true}>
        <TerminalOutputProvider value={writeRaw}>
          <TerminalImage
            image={{ data: PNG_1X1_BASE64, mimeType: 'image/png' }}
            contentWidth={10}
            availableTerminalHeight={4}
          />
        </TerminalOutputProvider>
      </VirtualViewportContext.Provider>,
    );

    await vi.waitFor(() => expect(writeRaw).toHaveBeenCalledOnce());
    const sequence = writeRaw.mock.calls[0]?.[0] as string;
    expect(sequence.startsWith('\u001b7\u001b[')).toBe(true);
    expect(sequence).toContain('\u001b]1337;File=inline=1');
    expect(sequence.endsWith('\u001b8')).toBe(true);
  });

  it('re-emits an iTerm2 image after it leaves and re-enters the viewport', async () => {
    process.env['QWEN_CODE_TERMINAL_IMAGE_PROTOCOL'] = 'iterm2';
    const writeRaw = vi.fn();
    const view = render(
      <VirtualViewportContext.Provider value={true}>
        <TerminalOutputProvider value={writeRaw}>
          <TerminalImage
            image={{ data: PNG_1X1_BASE64, mimeType: 'image/png' }}
            contentWidth={10}
            availableTerminalHeight={4}
          />
        </TerminalOutputProvider>
      </VirtualViewportContext.Provider>,
    );

    await vi.waitFor(() => expect(writeRaw).toHaveBeenCalledOnce());
    setStdoutRows(2);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('1x1 png]'));
    setStdoutRows(24);
    await vi.waitFor(() => expect(writeRaw).toHaveBeenCalledTimes(2));
  });

  it('does not use absolute iTerm2 placement in the main-screen buffer', () => {
    process.env['QWEN_CODE_TERMINAL_IMAGE_PROTOCOL'] = 'iterm2';
    const writeRaw = vi.fn();
    const { lastFrame } = render(
      <VirtualViewportContext.Provider value={false}>
        <TerminalOutputProvider value={writeRaw}>
          <TerminalImage
            image={{ data: PNG_1X1_BASE64, mimeType: 'image/png' }}
            contentWidth={10}
            availableTerminalHeight={4}
          />
        </TerminalOutputProvider>
      </VirtualViewportContext.Provider>,
    );

    expect(lastFrame()).toContain('[image: 1x1 png]');
    expect(writeRaw).not.toHaveBeenCalled();
  });

  it('uses descriptive text without protocol output for screen readers', async () => {
    process.env['QWEN_CODE_TERMINAL_IMAGE_PROTOCOL'] = 'kitty';
    vi.mocked(useIsScreenReaderEnabled).mockReturnValue(true);
    const writeRaw = vi.fn();
    const { lastFrame } = render(
      <TerminalOutputProvider value={writeRaw}>
        <TerminalImage
          image={{ data: PNG_1X1_BASE64, mimeType: 'image/png' }}
          contentWidth={20}
        />
      </TerminalOutputProvider>,
    );

    await vi.waitFor(() => expect(lastFrame()).toContain('[image: 1x1 png]'));
    expect(writeRaw).not.toHaveBeenCalled();
  });

  it('renders a readable placeholder when image protocols are unavailable', () => {
    process.env['QWEN_CODE_TERMINAL_IMAGE_PROTOCOL'] = 'off';
    const writeRaw = vi.fn();
    const { lastFrame } = render(
      <TerminalOutputProvider value={writeRaw}>
        <TerminalImage
          image={{ data: PNG_1X1_BASE64, mimeType: 'image/png' }}
          contentWidth={20}
        />
      </TerminalOutputProvider>,
    );

    expect(lastFrame()).toContain('[image: 1x1 png]');
    expect(writeRaw).not.toHaveBeenCalled();
  });
});

describe('calculateITerm2Placement', () => {
  it('rejects image rows that would be scrolled above the viewport', () => {
    const root = {
      yogaNode: {
        getComputedHeight: () => 30,
        getComputedLeft: () => 0,
        getComputedTop: () => 0,
      },
    } as unknown as DOMElement;
    const node = {
      parentNode: root,
      yogaNode: {
        getComputedHeight: () => 2,
        getComputedWidth: () => 10,
        getComputedLeft: () => 0,
        getComputedTop: () => 0,
      },
    } as unknown as DOMElement;

    expect(calculateITerm2Placement(node, 24, 2)).toBeNull();
  });

  it('rejects images that would extend past the right viewport edge', () => {
    const root = {
      yogaNode: {
        getComputedHeight: () => 10,
        getComputedLeft: () => 0,
        getComputedTop: () => 0,
      },
    } as unknown as DOMElement;
    const node = {
      parentNode: root,
      yogaNode: {
        getComputedHeight: () => 2,
        getComputedWidth: () => 10,
        getComputedLeft: () => 75,
        getComputedTop: () => 0,
      },
    } as unknown as DOMElement;

    expect(calculateITerm2Placement(node, 24, 2, 80, 10)).toBeNull();
  });
});
