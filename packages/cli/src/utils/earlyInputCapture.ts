/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Early Input Capture - Capture user input during REPL initialization
 *
 * Principle: Start raw mode stdin listening at the earliest CLI entry point,
 * then inject buffered content when REPL is ready. Solves the problem of
 * user input being lost during startup.
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('EARLY_INPUT');

/** Maximum buffer size (64KB) */
const MAX_BUFFER_SIZE = 64 * 1024;

/**
 * Input buffer - collects chunks and concatenates on retrieval to avoid O(n^2) copies.
 */
interface InputBuffer {
  /** Collected raw byte chunks */
  chunks: Buffer[];
  /** Total bytes across all chunks */
  totalBytes: number;
  /** Whether capture is complete */
  captured: boolean;
}

let inputBuffer: InputBuffer = {
  chunks: [],
  totalBytes: 0,
  captured: false,
};

let captureHandler: ((data: Buffer) => void) | null = null;
let captureStdin: NodeJS.ReadStream | null = null;
let isCapturing = false;
let pendingTerminalResponse = Buffer.alloc(0);

type EscapeSequenceClassification = 'terminal' | 'user' | 'incomplete';

/**
 * Classify ESC sequences seen during startup capture.
 * - terminal: known terminal response/query payloads that should be filtered
 * - user: known user key sequences that should be preserved
 * - incomplete: prefix too short to classify yet, buffer for next chunk
 *
 * Note: User input function key sequences should be preserved:
 * - ESC [ A/B/C/D - Arrow keys
 * - ESC O P/Q/R/S - F1-F4 (SS3 sequences)
 * - ESC [ 1;5A - Ctrl+arrow and other modified keys
 */
function classifyEscapeSequence(
  data: Buffer,
  startIdx: number,
): EscapeSequenceClassification {
  if (startIdx >= data.length || data[startIdx] !== 0x1b) {
    return 'user';
  }

  const nextIdx = startIdx + 1;
  if (nextIdx >= data.length) {
    return 'incomplete';
  }

  const nextByte = data[nextIdx];

  // Check for special characters directly after ESC
  // P = 0x50 (DCS), _ = 0x5F (APC), ^ = 0x5E (PM), ] = 0x5D (OSC)
  // Note: O = 0x4F is SS3 sequence for function keys, should be preserved
  if (
    nextByte === 0x50 || // P (DCS)
    nextByte === 0x5f || // _ (APC)
    nextByte === 0x5e || // ^ (PM)
    nextByte === 0x5d // ] (OSC)
  ) {
    return 'terminal';
  }

  // Check for terminal responses in CSI sequences
  // ESC [ ? ... (DEC private mode response)
  // ESC [ > ... (DA2 response)
  if (nextByte === 0x5b) {
    // CSI sequence, check third character
    const thirdIdx = startIdx + 2;
    if (thirdIdx >= data.length) {
      return 'incomplete';
    }
    const thirdByte = data[thirdIdx];
    if (thirdByte === 0x3f || thirdByte === 0x3e) {
      // ESC [ ? or ESC [ > - this is a terminal response
      return 'terminal';
    }
    return 'user';
  }

  return 'user';
}

/**
 * Skip terminal response sequence
 * Returns the index position after skipping
 */
function skipTerminalResponse(
  data: Buffer,
  startIdx: number,
): { nextIndex: number; complete: boolean } {
  if (startIdx >= data.length || data[startIdx] !== 0x1b) {
    return { nextIndex: startIdx + 1, complete: true };
  }

  const nextIdx = startIdx + 1;
  if (nextIdx >= data.length) {
    return { nextIndex: nextIdx, complete: false };
  }

  const nextByte = data[nextIdx];

  // OSC sequence: ESC ] ... BEL or ESC ] ... ST
  if (nextByte === 0x5d) {
    let i = startIdx + 2;
    while (i < data.length) {
      // BEL (0x07) or ST (ESC \)
      if (data[i] === 0x07) {
        return { nextIndex: i + 1, complete: true };
      }
      if (data[i] === 0x1b && i + 1 < data.length && data[i + 1] === 0x5c) {
        return { nextIndex: i + 2, complete: true };
      }
      i++;
    }
    return { nextIndex: data.length, complete: false };
  }

  // DCS/APC/PM sequences: ESC P/_/^ ... ST
  if (nextByte === 0x50 || nextByte === 0x5f || nextByte === 0x5e) {
    let i = startIdx + 2;
    while (i < data.length) {
      // ST (ESC \)
      if (data[i] === 0x1b && i + 1 < data.length && data[i + 1] === 0x5c) {
        return { nextIndex: i + 2, complete: true };
      }
      i++;
    }
    return { nextIndex: data.length, complete: false };
  }

  // CSI sequence: ESC [ ... (ends with 0x40-0x7E)
  if (nextByte === 0x5b) {
    let i = startIdx + 2;
    while (i < data.length) {
      const byte = data[i];
      // CSI sequences end with 0x40-0x7E
      if (byte >= 0x40 && byte <= 0x7e) {
        return { nextIndex: i + 1, complete: true };
      }
      i++;
    }
    return { nextIndex: data.length, complete: false };
  }

  return { nextIndex: startIdx + 1, complete: true };
}

/**
 * Filter terminal response sequences (like Kitty protocol responses, device attributes, etc.)
 * Preserve user input (including function keys like arrow keys)
 */
function filterTerminalResponses(data: Buffer): {
  filtered: Buffer;
  trailingPartialTerminalResponse: Buffer;
} {
  const result = Buffer.allocUnsafe(data.length);
  let writeIdx = 0;
  let i = 0;

  while (i < data.length) {
    // Detect ESC sequences
    if (data[i] === 0x1b) {
      const sequenceType = classifyEscapeSequence(data, i);
      if (sequenceType === 'incomplete') {
        return {
          filtered: result.subarray(0, writeIdx),
          trailingPartialTerminalResponse: data.subarray(i),
        };
      }
      // Check if this is a terminal response (should be filtered out)
      if (sequenceType === 'terminal') {
        // Skip the terminal response sequence
        const skipResult = skipTerminalResponse(data, i);
        if (!skipResult.complete) {
          return {
            filtered: result.subarray(0, writeIdx),
            trailingPartialTerminalResponse: data.subarray(i),
          };
        }
        i = skipResult.nextIndex;
        continue;
      }
      // User input function keys (like arrow keys ESC [A), preserve
    }
    // Preserve current byte
    result[writeIdx++] = data[i];
    i++;
  }

  return {
    filtered: result.subarray(0, writeIdx),
    trailingPartialTerminalResponse: Buffer.alloc(0),
  };
}

/**
 * Start early input capture
 * Call immediately after setting raw mode in gemini.tsx
 */
export function startEarlyInputCapture(): void {
  if (isCapturing || !process.stdin.isTTY) {
    if (!process.stdin.isTTY) {
      debugLogger.debug('Early input capture skipped: stdin is not a TTY');
    }
    return;
  }

  // Check if disabled
  if (process.env['QWEN_CODE_DISABLE_EARLY_CAPTURE'] === '1') {
    debugLogger.debug('Early input capture disabled by environment variable');
    return;
  }

  isCapturing = true;
  inputBuffer = {
    chunks: [],
    totalBytes: 0,
    captured: false,
  };
  pendingTerminalResponse = Buffer.alloc(0);

  debugLogger.debug('Starting early input capture');

  captureHandler = (data: Buffer) => {
    if (inputBuffer.captured) {
      return;
    }

    // Check buffer size limit
    if (inputBuffer.totalBytes >= MAX_BUFFER_SIZE) {
      debugLogger.warn(
        `Early input capture buffer full (${MAX_BUFFER_SIZE} bytes). Stopping capture; additional keystrokes during startup will be lost.`,
      );
      stopEarlyInputCapture();
      return;
    }

    const dataToFilter =
      pendingTerminalResponse.length > 0
        ? Buffer.concat([pendingTerminalResponse, data])
        : data;
    pendingTerminalResponse = Buffer.alloc(0);

    // Filter out terminal response sequences (like Kitty protocol responses)
    const { filtered, trailingPartialTerminalResponse } =
      filterTerminalResponses(dataToFilter);
    if (trailingPartialTerminalResponse.length > 0) {
      pendingTerminalResponse = Buffer.from(trailingPartialTerminalResponse);
    }

    if (filtered.length > 0) {
      // Limit buffer size
      const newLength = inputBuffer.totalBytes + filtered.length;
      if (newLength > MAX_BUFFER_SIZE) {
        const truncated = filtered.subarray(
          0,
          MAX_BUFFER_SIZE - inputBuffer.totalBytes,
        );
        inputBuffer.chunks.push(Buffer.from(truncated));
        inputBuffer.totalBytes += truncated.length;
        debugLogger.debug(`Buffer truncated at ${MAX_BUFFER_SIZE} bytes`);
      } else {
        inputBuffer.chunks.push(Buffer.from(filtered));
        inputBuffer.totalBytes += filtered.length;
        debugLogger.debug(
          `Captured ${filtered.length} bytes (total: ${inputBuffer.totalBytes})`,
        );
      }
    }
  };

  captureStdin = process.stdin;
  captureStdin.on('data', captureHandler);
}

/**
 * Stop early input capture
 * Call before KeypressProvider mounts
 */
export function stopEarlyInputCapture(): void {
  if (!isCapturing || !captureHandler || !captureStdin) {
    return;
  }

  captureStdin.removeListener('data', captureHandler);
  captureStdin = null;
  captureHandler = null;
  isCapturing = false;
  inputBuffer.captured = true;

  debugLogger.debug(
    `Stopped early input capture: ${inputBuffer.totalBytes} bytes`,
  );
}

/**
 * Get and clear captured input
 * For use by KeypressContext
 */
export function getAndClearCapturedInput(): Buffer {
  const parts = [...inputBuffer.chunks];
  if (pendingTerminalResponse.length > 0) {
    parts.push(Buffer.from(pendingTerminalResponse));
  }
  const buffer = parts.length > 0 ? Buffer.concat(parts) : Buffer.alloc(0);
  inputBuffer.chunks = [];
  inputBuffer.totalBytes = 0;
  pendingTerminalResponse = Buffer.alloc(0);
  // Keep captured=true — capture has completed, don't re-arm
  return buffer;
}

/**
 * Stop capture and return captured input in one atomic operation.
 * Preferred over calling stopEarlyInputCapture + getAndClearCapturedInput separately.
 */
export function stopAndGetCapturedInput(): Buffer {
  stopEarlyInputCapture();
  return getAndClearCapturedInput();
}

/**
 * Check if there is captured input
 */
export function hasCapturedInput(): boolean {
  return inputBuffer.totalBytes > 0;
}

/**
 * Reset capture state (for testing only)
 */
export function resetCaptureState(): void {
  if (captureHandler && captureStdin) {
    captureStdin.removeListener('data', captureHandler);
  } else if (captureHandler) {
    process.stdin.removeListener('data', captureHandler);
  }
  captureStdin = null;
  captureHandler = null;
  isCapturing = false;
  inputBuffer = {
    chunks: [],
    totalBytes: 0,
    captured: false,
  };
  pendingTerminalResponse = Buffer.alloc(0);
}
