/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { SettingsCorruptedDialog } from './SettingsCorruptedDialog.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';

const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  predicate: () => void,
  options: { timeout?: number; interval?: number } = {},
) => {
  const { timeout = 1000, interval = 10 } = options;
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeout) {
    try {
      predicate();
      return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error('waitFor timed out');
};

enum TerminalKeys {
  ENTER = '\u000D',
  UP_ARROW = '\u001B[A',
  DOWN_ARROW = '\u001B[B',
  ESCAPE = '\u001B',
}

describe('SettingsCorruptedDialog', () => {
  const mockCorruptedPath = '/home/user/.qwen/settings.json.corrupted';
  const mockOnExit = vi.fn();
  const mockOnContinue = vi.fn();

  beforeEach(() => {
    mockOnExit.mockClear();
    mockOnContinue.mockClear();
  });

  it('should show recovered settings label when wasRecovered=true', async () => {
    const { lastFrame, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SettingsCorruptedDialog
          corruptedPath={mockCorruptedPath}
          wasRecovered={true}
          onExit={mockOnExit}
          onContinue={mockOnContinue}
        />
      </KeypressProvider>,
    );

    await wait();
    await waitFor(() => {
      expect(lastFrame()).toContain('Continue with recovered settings (esc)');
    });
    unmount();
  });

  it('should show empty settings label when wasRecovered=false', async () => {
    const { lastFrame, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SettingsCorruptedDialog
          corruptedPath={mockCorruptedPath}
          wasRecovered={false}
          onExit={mockOnExit}
          onContinue={mockOnContinue}
        />
      </KeypressProvider>,
    );

    await wait();
    await waitFor(() => {
      expect(lastFrame()).toContain('Continue with empty settings (esc)');
    });
    unmount();
  });

  it('should move selection with up/down arrows', async () => {
    const { stdin, lastFrame, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SettingsCorruptedDialog
          corruptedPath={mockCorruptedPath}
          wasRecovered={false}
          onExit={mockOnExit}
          onContinue={mockOnContinue}
        />
      </KeypressProvider>,
    );

    await wait();
    // Initially EXIT is selected
    await waitFor(() => {
      expect(lastFrame()).toContain('>');
    });

    // Press down to move to CONTINUE
    stdin.write(TerminalKeys.DOWN_ARROW as string);
    await wait();
    await waitFor(() => {
      expect(lastFrame()).toContain('>');
    });

    // Press up to move back to EXIT
    stdin.write(TerminalKeys.UP_ARROW as string);
    await wait();
    await waitFor(() => {
      expect(lastFrame()).toContain('>');
    });

    unmount();
  });

  it('should call onExit when pressing Enter on EXIT option', async () => {
    const { stdin, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SettingsCorruptedDialog
          corruptedPath={mockCorruptedPath}
          wasRecovered={false}
          onExit={mockOnExit}
          onContinue={mockOnContinue}
        />
      </KeypressProvider>,
    );

    await wait();
    stdin.write(TerminalKeys.ENTER as string);
    await wait();
    await waitFor(() => {
      expect(mockOnExit).toHaveBeenCalled();
      expect(mockOnContinue).not.toHaveBeenCalled();
    });

    unmount();
  });

  it('should call onContinue when pressing Enter on CONTINUE option', async () => {
    const { stdin, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SettingsCorruptedDialog
          corruptedPath={mockCorruptedPath}
          wasRecovered={false}
          onExit={mockOnExit}
          onContinue={mockOnContinue}
        />
      </KeypressProvider>,
    );

    await wait();
    stdin.write(TerminalKeys.DOWN_ARROW as string);
    await wait();
    stdin.write(TerminalKeys.ENTER as string);
    await wait();
    await waitFor(() => {
      expect(mockOnContinue).toHaveBeenCalled();
      expect(mockOnExit).not.toHaveBeenCalled();
    });

    unmount();
  });

  it('should call onContinue when pressing escape', async () => {
    const { stdin, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SettingsCorruptedDialog
          corruptedPath={mockCorruptedPath}
          wasRecovered={false}
          onExit={mockOnExit}
          onContinue={mockOnContinue}
        />
      </KeypressProvider>,
    );

    await wait();
    stdin.write(TerminalKeys.ESCAPE as string);
    await wait();
    await waitFor(() => {
      expect(mockOnContinue).toHaveBeenCalled();
      expect(mockOnExit).not.toHaveBeenCalled();
    });

    unmount();
  });

  it('should call onExit when pressing Ctrl+C', async () => {
    const { stdin, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SettingsCorruptedDialog
          corruptedPath={mockCorruptedPath}
          wasRecovered={false}
          onExit={mockOnExit}
          onContinue={mockOnContinue}
        />
      </KeypressProvider>,
    );

    await wait();
    stdin.write('\x03');
    await wait();
    await waitFor(() => {
      expect(mockOnExit).toHaveBeenCalled();
      expect(mockOnContinue).not.toHaveBeenCalled();
    });

    unmount();
  });

  it('should display the corrupted file path', async () => {
    const { lastFrame, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SettingsCorruptedDialog
          corruptedPath={mockCorruptedPath}
          wasRecovered={false}
          onExit={mockOnExit}
          onContinue={mockOnContinue}
        />
      </KeypressProvider>,
    );

    await wait();
    await waitFor(() => {
      expect(lastFrame()).toContain(mockCorruptedPath);
    });
    unmount();
  });
});
