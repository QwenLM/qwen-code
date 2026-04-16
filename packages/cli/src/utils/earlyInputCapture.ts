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
let isCapturing = false;

/**
 * Check if this is a terminal response sequence
 * Terminal responses typically start with specific prefixes
 *
 * Note: User input function key sequences should be preserved:
 * - ESC [ A/B/C/D - Arrow keys
 * - ESC O P/Q/R/S - F1-F4 (SS3 sequences)
 * - ESC [ 1;5A - Ctrl+arrow and other modified keys
 */
function isTerminalResponse(data: Buffer, startIdx: number): boolean {
  if (startIdx >= data.length || data[startIdx] !== 0x1b) {
    return false;
  }

  const nextIdx = startIdx + 1;
  if (nextIdx >= data.length) {
    return false;
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
    return true;
  }

  // Check for terminal responses in CSI sequences
  // ESC [ ? ... (DEC private mode response)
  // ESC [ > ... (DA2 response)
  if (nextByte === 0x5b) {
    // CSI sequence, check third character
    const thirdIdx = startIdx + 2;
    if (thirdIdx < data.length) {
      const thirdByte = data[thirdIdx];
      if (thirdByte === 0x3f || thirdByte === 0x3e) {
        // ESC [ ? or ESC [ > - this is a terminal response
        return true;
      }
    }
  }

  return false;
}

/**
 * Skip terminal response sequence
 * Returns the index position after skipping
 */
function skipTerminalResponse(data: Buffer, startIdx: number): number {
  if (startIdx >= data.length || data[startIdx] !== 0x1b) {
    return startIdx + 1;
  }

  const nextIdx = startIdx + 1;
  if (nextIdx >= data.length) {
    return nextIdx;
  }

  const nextByte = data[nextIdx];

  // OSC sequence: ESC ] ... BEL or ESC ] ... ST
  if (nextByte === 0x5d) {
    let i = startIdx + 2;
    while (i < data.length) {
      // BEL (0x07) or ST (ESC \)
      if (data[i] === 0x07) {
        return i + 1;
      }
      if (data[i] === 0x1b && i + 1 < data.length && data[i + 1] === 0x5c) {
        return i + 2;
      }
      i++;
    }
    return data.length;
  }

  // DCS/APC/PM sequences: ESC P/_/^ ... ST
  if (nextByte === 0x50 || nextByte === 0x5f || nextByte === 0x5e) {
    let i = startIdx + 2;
    while (i < data.length) {
      // ST (ESC \)
      if (data[i] === 0x1b && i + 1 < data.length && data[i + 1] === 0x5c) {
        return i + 2;
      }
      i++;
    }
    return data.length;
  }

  // CSI sequence: ESC [ ... (ends with 0x40-0x7E)
  if (nextByte === 0x5b) {
    let i = startIdx + 2;
    while (i < data.length) {
      const byte = data[i];
      // CSI sequences end with 0x40-0x7E
      if (byte >= 0x40 && byte <= 0x7e) {
        return i + 1;
      }
      i++;
    }
    return data.length;
  }

  return startIdx + 1;
}

/**
 * Filter terminal response sequences (like Kitty protocol responses, device attributes, etc.)
 * Preserve user input (including function keys like arrow keys)
 *
 * Note: This filter operates on a single data chunk. Terminal response sequences
 * split across multiple data events will not be detected and may leak into the
 * buffer. In practice this is rare since terminal responses arrive as complete chunks.
 */
function filterTerminalResponses(data: Buffer): Buffer {
  const result = Buffer.allocUnsafe(data.length);
  let writeIdx = 0;
  let i = 0;

  while (i < data.length) {
    // Detect ESC sequences
    if (data[i] === 0x1b) {
      // Check if this is a terminal response (should be filtered out)
      if (isTerminalResponse(data, i)) {
        // Skip the terminal response sequence
        i = skipTerminalResponse(data, i);
        continue;
      }
      // User input function keys (like arrow keys ESC [A), preserve
    }
    // Preserve current byte
    result[writeIdx++] = data[i];
    i++;
  }

  return result.subarray(0, writeIdx);
}

/**
 * Start early input capture
 * Call immediately after setting raw mode in gemini.tsx
 */
export function startEarlyInputCapture(): void {
  if (isCapturing || !process.stdin.isTTY) {
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

  debugLogger.debug('Starting early input capture');

  captureHandler = (data: Buffer) => {
    if (inputBuffer.captured) {
      return;
    }

    // Check buffer size limit
    if (inputBuffer.totalBytes >= MAX_BUFFER_SIZE) {
      debugLogger.debug('Buffer size limit reached, stopping capture');
      return;
    }

    // Filter out terminal response sequences (like Kitty protocol responses)
    const filtered = filterTerminalResponses(data);
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

  process.stdin.on('data', captureHandler);
}

/**
 * Stop early input capture
 * Call before KeypressProvider mounts
 */
export function stopEarlyInputCapture(): void {
  if (!isCapturing || !captureHandler) {
    return;
  }

  process.stdin.removeListener('data', captureHandler);
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
  const buffer =
    inputBuffer.chunks.length > 0
      ? Buffer.concat(inputBuffer.chunks)
      : Buffer.alloc(0);
  inputBuffer.chunks = [];
  inputBuffer.totalBytes = 0;
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
  if (captureHandler) {
    process.stdin.removeListener('data', captureHandler);
    captureHandler = null;
  }
  isCapturing = false;
  inputBuffer = {
    chunks: [],
    totalBytes: 0,
    captured: false,
  };
}
