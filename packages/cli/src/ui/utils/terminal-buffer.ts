/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const RESTORE_TERMINAL_FROM_ALT_SCREEN = '\x1b[?25h\x1b[?1049l';

export function shouldUseVirtualViewport(
  useTerminalBuffer: boolean | undefined,
  screenReader: boolean,
): boolean {
  return (useTerminalBuffer ?? true) && !screenReader;
}

export function installAlternateScreenExitHandler(
  enabled: boolean,
): () => void {
  if (!enabled || !process.stdout.isTTY) {
    return () => {};
  }

  const restoreTerminal = () => {
    process.stdout.write(RESTORE_TERMINAL_FROM_ALT_SCREEN);
  };

  process.once('exit', restoreTerminal);
  return () => {
    process.removeListener('exit', restoreTerminal);
  };
}
