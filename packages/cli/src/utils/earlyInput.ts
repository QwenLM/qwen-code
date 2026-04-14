/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

type EarlyInputState = {
  chunks: Buffer[];
  listener: ((chunk: Buffer) => void) | null;
  wasRaw: boolean;
  changedRawMode: boolean;
} | null;

let earlyInputState: EarlyInputState = null;

const supportsRawMode = (
  stdin: typeof process.stdin,
): stdin is typeof process.stdin & {
  setRawMode: (mode: boolean) => void;
} => typeof stdin.setRawMode === 'function';

export function startCapturingEarlyInput(): void {
  if (
    earlyInputState ||
    !process.stdin.isTTY ||
    !supportsRawMode(process.stdin)
  ) {
    return;
  }

  const wasRaw = process.stdin.isRaw ?? false;
  const changedRawMode = !wasRaw;
  if (changedRawMode) {
    process.stdin.setRawMode(true);
  }

  const chunks: Buffer[] = [];
  const listener = (chunk: Buffer) => {
    chunks.push(Buffer.from(chunk));
  };

  earlyInputState = {
    chunks,
    listener,
    wasRaw,
    changedRawMode,
  };

  process.stdin.resume();
  process.stdin.on('data', listener);
}

export function drainEarlyInput(): Buffer[] {
  if (!earlyInputState) {
    return [];
  }

  const { chunks, listener, wasRaw, changedRawMode } = earlyInputState;
  earlyInputState = null;

  if (listener) {
    process.stdin.removeListener('data', listener);
  }

  if (changedRawMode && supportsRawMode(process.stdin)) {
    process.stdin.setRawMode(wasRaw);
  }

  return chunks;
}
