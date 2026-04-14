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

export const EARLY_INPUT_ENV_KEY = 'QWEN_CODE_EARLY_INPUT';

let earlyInputState: EarlyInputState = null;

const supportsRawMode = (
  stdin: typeof process.stdin,
): stdin is typeof process.stdin & {
  setRawMode: (mode: boolean) => void;
} => typeof stdin.setRawMode === 'function';

function consumeSerializedEarlyInputFromEnv(): Buffer[] {
  const serialized = process.env[EARLY_INPUT_ENV_KEY];
  if (!serialized) {
    return [];
  }

  delete process.env[EARLY_INPUT_ENV_KEY];

  try {
    const encodedChunks = JSON.parse(serialized) as string[];
    return encodedChunks.map((chunk) => Buffer.from(chunk, 'base64'));
  } catch {
    return [];
  }
}

export function serializeEarlyInputChunks(
  chunks: readonly Buffer[],
): string | undefined {
  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.stringify(chunks.map((chunk) => chunk.toString('base64')));
}

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

  const chunks = consumeSerializedEarlyInputFromEnv();
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
