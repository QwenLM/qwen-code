/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

let terminalTeardown: (() => void) | undefined;

export function setTerminalTeardown(teardown: () => void): () => void {
  terminalTeardown = teardown;
  return () => {
    if (terminalTeardown === teardown) {
      terminalTeardown = undefined;
    }
  };
}

export function runTerminalTeardown(): void {
  try {
    terminalTeardown?.();
  } catch {
    // Best-effort terminal restoration.
  }
}

process.on('exit', runTerminalTeardown);
