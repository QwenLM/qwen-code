/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

let detectionComplete = false;
let protocolSupported = false;
let protocolEnabled = false;

// Progressive-enhancement flag stack control (per screen buffer):
//   push (enable) / pop (disable). See
//   https://sw.kovidgoyal.net/kitty/keyboard-protocol/
const KITTY_KEYBOARD_PUSH = '\x1b[>1u';
const KITTY_KEYBOARD_POP = '\x1b[<u';

function enableProtocol(): void {
  process.stdout.write(KITTY_KEYBOARD_PUSH);
  protocolEnabled = true;
}

/**
 * Detects Kitty keyboard protocol support.
 * Definitive document about this protocol lives at https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 * This function should be called once at app startup.
 */
export async function detectAndEnableKittyProtocol(): Promise<boolean> {
  if (detectionComplete) {
    return protocolSupported;
  }

  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      detectionComplete = true;
      resolve(false);
      return;
    }

    const originalRawMode = process.stdin.isRaw;
    if (!originalRawMode) {
      process.stdin.setRawMode(true);
    }

    let responseBuffer = '';
    let progressiveEnhancementReceived = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const onTimeout = () => {
      timeoutId = undefined;
      process.stdin.removeListener('data', handleData);

      // Keep a drain handler briefly to consume any late-arriving terminal
      // responses that would otherwise leak into the application input.
      const drainHandler = () => {};
      process.stdin.on('data', drainHandler);

      setTimeout(() => {
        process.stdin.removeListener('data', drainHandler);
        if (!originalRawMode) {
          process.stdin.setRawMode(false);
        }
        detectionComplete = true;
        resolve(false);
      }, 100);
    };

    const handleData = (data: Buffer) => {
      if (timeoutId === undefined) {
        // Race condition. We have already timed out.
        return;
      }
      responseBuffer += data.toString();

      // Check for progressive enhancement response (CSI ? <flags> u)
      if (responseBuffer.includes('\x1b[?') && responseBuffer.includes('u')) {
        progressiveEnhancementReceived = true;
        // Give more time to get the full set of kitty responses if we have an
        // indication the terminal probably supports kitty and we just need to
        // wait a bit longer for a response.
        clearTimeout(timeoutId);
        timeoutId = setTimeout(onTimeout, 1000);
      }

      // Check for device attributes response (CSI ? <attrs> c)
      if (responseBuffer.includes('\x1b[?') && responseBuffer.includes('c')) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
        process.stdin.removeListener('data', handleData);

        if (!originalRawMode) {
          process.stdin.setRawMode(false);
        }

        if (progressiveEnhancementReceived) {
          // Enable the protocol
          protocolSupported = true;
          enableProtocol();

          // Set up cleanup on exit (exit covers process.exit() calls,
          // SIGTERM/SIGINT cover signal-based terminations).
          process.on('exit', disableProtocol);
          process.on('SIGTERM', disableProtocol);
          process.on('SIGINT', disableProtocol);
        }

        detectionComplete = true;
        resolve(protocolSupported);
      }
    };

    process.stdin.on('data', handleData);

    // Send queries
    process.stdout.write('\x1b[?u'); // Query progressive enhancement
    process.stdout.write('\x1b[c'); // Query device attributes

    // Timeout after 200ms
    // When a iterm2 terminal does not have focus this can take over 90s on a
    // fast macbook so we need a somewhat longer threshold than would be ideal.
    timeoutId = setTimeout(onTimeout, 200);
  });
}

function disableProtocol() {
  if (protocolEnabled) {
    process.stdout.write(KITTY_KEYBOARD_POP);
    protocolEnabled = false;
  }
}

/**
 * Re-pushes the Kitty keyboard progressive-enhancement flags onto the screen
 * buffer that is current at call time.
 *
 * The flags are pushed once at startup (during detection) on the main screen,
 * but the Kitty spec tracks them per screen buffer. When the app switches to
 * the alternate screen (VP mode / `alternateScreen: true`), that screen's flag
 * stack is empty, so modified keys such as Shift+Enter are reported without
 * their modifier — Shift+Enter degrades to a bare Enter or an orphaned Escape.
 * Callers must invoke this only after the alternate screen has been entered.
 *
 * No-op unless the protocol was detected as supported, so it is safe to call
 * unconditionally on the VP startup path.
 */
export function pushKittyProtocolFlags(): void {
  if (protocolSupported) {
    enableProtocol();
  }
}

/**
 * Explicitly disables the Kitty keyboard protocol. Should be called during
 * application cleanup before process.exit() to ensure the terminal is restored
 * even if the 'exit' event handler does not fire in time (e.g. on SIGKILL).
 */
export function disableKittyProtocol(): void {
  disableProtocol();
}

export function isKittyProtocolEnabled(): boolean {
  return protocolEnabled;
}

export function isKittyProtocolSupported(): boolean {
  return protocolSupported;
}
