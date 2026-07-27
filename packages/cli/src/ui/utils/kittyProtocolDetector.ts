/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

let detectionComplete = false;
let protocolSupported = false;
/**
 * Stack depth of the Kitty keyboard protocol escape flags. The flags are
 * pushed once on the main screen at startup, and pushed again on the alternate
 * screen when VP mode is active. The Kitty spec tracks the flag stack per
 * screen buffer, so two pushes require two pops — one on each screen.
 * Tracking depth rather than a boolean lets the teardown code correctly
 * balance both screen buffers. See #7779.
 */
let kittyPushDepth = 0;

// Progressive-enhancement flag stack control (per screen buffer):
//   push (enable) / pop (disable). See
//   https://sw.kovidgoyal.net/kitty/keyboard-protocol/
const KITTY_KEYBOARD_PUSH = '\x1b[>1u';
const KITTY_KEYBOARD_POP = '\x1b[<u';

function enableProtocol(): void {
  process.stdout.write(KITTY_KEYBOARD_PUSH);
  kittyPushDepth++;
}

/**
 * Pop one Kitty keyboard protocol flag from the current screen buffer's stack.
 * No-op when the stack is already empty (depth < 1). The exit fallback writes
 * a coordinated \x1b[?1049l inline when depth > 1 so each screen buffer is
 * correctly balanced. See #7779.
 */
function popKittyProtocol(): void {
  if (kittyPushDepth > 0) {
    process.stdout.write(KITTY_KEYBOARD_POP);
    kittyPushDepth--;
  }
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

          // Set up best-effort cleanup on process exit. Signal-based
          // terminations are routed through gemini.tsx → runExitCleanup(),
          // which unmounts Ink and pops both screen-buffer stacks in the
          // correct order. Raw SIGTERM/SIGINT handlers here used to pop before
          // unmount, consuming only the alternate-screen stack and leaving the
          // main-screen push active (#7779), so they intentionally live in the
          // coordinated cleanup path now.
          process.on('exit', cleanupKittyProtocolOnExit);
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

function cleanupKittyProtocolOnExit(): void {
  if (kittyPushDepth === 0) return;
  try {
    // With VP enabled the top stack belongs to the alternate screen. Pop it
    // while that screen is current, return to the main screen, then pop the
    // startup push there. A conforming Kitty terminal treats a pop on an empty
    // stack as a no-op, so this remains safe if the alternate screen was never
    // entered but depth somehow exceeds one.
    if (kittyPushDepth > 1) {
      process.stdout.write(
        `${KITTY_KEYBOARD_POP}\x1b[?1049l${KITTY_KEYBOARD_POP}`,
      );
      kittyPushDepth = Math.max(0, kittyPushDepth - 2);
    }
    while (kittyPushDepth > 0) {
      process.stdout.write(KITTY_KEYBOARD_POP);
      kittyPushDepth--;
    }
  } catch {
    // Best-effort: stdout may already be closed (e.g. EPIPE).
    kittyPushDepth = 0;
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
 * Pop one Kitty keyboard protocol flag from the **current** screen buffer's
 * stack. The cleanup chain calls this while on the alternate screen (before
 * Ink unmount) and again after returning to the main screen (after unmount).
 * The depth counter prevents an extra pop when a corresponding push never
 * occurred. See #7779.
 */
export function popKittyProtocolFlags(): void {
  popKittyProtocol();
}

export function getKittyProtocolDepth(): number {
  return kittyPushDepth;
}

export function isKittyProtocolEnabled(): boolean {
  return kittyPushDepth > 0;
}

export function isKittyProtocolSupported(): boolean {
  return protocolSupported;
}
