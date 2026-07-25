/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { AlternateScreen } from './AlternateScreen.js';

const writeRaw = vi.fn();
vi.mock('../contexts/TerminalOutputContext.js', () => ({
  useTerminalOutput: () => writeRaw,
}));
vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ rows: 24, columns: 80 }),
}));

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

describe('<AlternateScreen />', () => {
  const origIsTTY = process.stdout.isTTY;
  const setTTY = (value: boolean) =>
    Object.defineProperty(process.stdout, 'isTTY', {
      value,
      configurable: true,
    });

  afterEach(() => {
    writeRaw.mockClear();
    setTTY(origIsTTY);
  });

  it('enters on mount and exits on unmount when stdout is a TTY', () => {
    setTTY(true);
    const { unmount } = render(
      <AlternateScreen>
        <Text>x</Text>
      </AlternateScreen>,
    );
    expect(writeRaw).toHaveBeenCalledWith(
      expect.stringContaining(ENTER_ALT_SCREEN),
    );

    writeRaw.mockClear();
    unmount();
    expect(writeRaw).toHaveBeenCalledWith(
      expect.stringContaining(EXIT_ALT_SCREEN),
    );
  });

  it('skips escape writes when disabled (VP mode owns the alt screen)', () => {
    setTTY(true);
    const { unmount } = render(
      <AlternateScreen disabled>
        <Text>x</Text>
      </AlternateScreen>,
    );
    expect(writeRaw).not.toHaveBeenCalled();
    unmount();
  });

  it('skips escape writes when stdout is not a TTY (piped/CI)', () => {
    setTTY(false);
    const { unmount } = render(
      <AlternateScreen>
        <Text>x</Text>
      </AlternateScreen>,
    );
    expect(writeRaw).not.toHaveBeenCalled();
    unmount();
  });
});
