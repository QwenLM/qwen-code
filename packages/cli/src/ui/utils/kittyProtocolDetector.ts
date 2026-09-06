/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

let detectionComplete = false;
let protocolSupported = false;

// Progressive-enhancement flag stack control (per screen buffer):
//   push (enable) / pop (disable). See
//   https://sw.kovidgoyal.net/kitty/keyboard-protocol/
//
// The kitty spec requires terminals to keep independent flag stacks for the
// main and alternate screen buffers, so every push must be balanced by a pop
// written while its screen buffer is still current (#7779):
//   - the detection-time push lands on the main screen (startup runs there);
//   - pushKittyProtocolFlags() lands on the alternate screen (callers invoke
//     it right after the alternate screen is entered);
//   - popKittyProtocolFlags() pops the alternate-screen push and must be
//     called before `ESC[?1049l` (leaving the alternate screen);
//   - disableKittyProtocol() pops the main-screen push and must be called
//     after returning to the main screen.
// A single boolean cannot model this: after the first pop it would report the
// protocol disabled while the other screen's push is still active.
let mainScreenPushActive = false;
let alternateScreenPushActive = false;
let exitFallbackRegistered = false;

const KITTY_KEYBOARD_PUSH = '\x1b[>1u';
const KITTY_KEYBOARD_POP = '\x1b[<u';

function enableProtocol(): void {
  process.stdout.write(KITTY_KEYBOARD_PUSH);
  mainScreenPushActive = true;
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

          // Last-resort fallback: if the process exits without running
          // the async cleanup chain (e.g. direct process.exit() call),
          // the 'exit' event still fires synchronously and restores the
          // terminal. The fallback only pops the main-screen push (a pop
          // aimed at the alternate screen would instead hit whichever
          // buffer is current). Signal-based teardown is handled by the
          // main installInteractiveSignalHandlers() → runExitCleanup() →
          // disableKittyProtocol() path, and renderers that enter the
          // alternate screen re-arm this fallback behind their own
          // signal-exit teardown via deferKittyProtocolExitFallback()
          // so the pop lands after `ESC[?1049l`, on the main screen.
          process.on('exit', disableProtocol);
          exitFallbackRegistered = true;
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
  // Pop only the main-screen push: this runs either from the explicit
  // cleanup path (after the renderer left the alternate screen) or from the
  // process-'exit' fallback, and in both cases the main screen is the buffer
  // whose push is still unbalanced. A still-active alternate-screen push is
  // unreachable once the alternate screen has been left — writing its pop
  // here would instead pop the *current* (main) screen's stack a second
  // time and could evict an entry the user's shell pushed (#7779).
  if (mainScreenPushActive) {
    process.stdout.write(KITTY_KEYBOARD_POP);
    mainScreenPushActive = false;
  }
  alternateScreenPushActive = false;
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
 * Callers must invoke this only after the alternate screen has been entered,
 * so the push lands on the alternate screen's stack.
 *
 * No-op unless the protocol was detected as supported (and the alternate
 * screen's push is not already active), so it is safe to call
 * unconditionally on the VP startup path.
 */
export function pushKittyProtocolFlags(): void {
  if (protocolSupported && !alternateScreenPushActive) {
    process.stdout.write(KITTY_KEYBOARD_PUSH);
    alternateScreenPushActive = true;
  }
}

/**
 * Pops the alternate screen's Kitty keyboard progressive-enhancement flags.
 *
 * Callers must invoke this while the alternate screen is still current —
 * i.e. *before* the renderer writes `ESC[?1049l` (leaving the alternate
 * screen). The kitty spec keeps independent flag stacks per screen buffer,
 * so a pop written after leaving the alternate screen would instead pop the
 * main screen's stack and leave the alternate screen's push dangling (#7779).
 *
 * No-op unless the alternate-screen push is active, so it is safe to call
 * unconditionally on teardown paths (including non-VP runs).
 */
export function popKittyProtocolFlags(): void {
  if (alternateScreenPushActive) {
    process.stdout.write(KITTY_KEYBOARD_POP);
    alternateScreenPushActive = false;
  }
}

/**
 * Re-arms the `process.on('exit')` fallback so it runs *after* listeners
 * registered later than detection — notably Ink's render-time signal-exit
 * subscription, which restores the terminal and leaves the alternate screen.
 *
 * 'exit' listeners run in registration order. The fallback is registered at
 * detection time, before the renderer subscribes, so without this re-arm a
 * crash path that skips the cleanup chain (direct `process.exit()`) would pop
 * the flags while the alternate screen is still current: the pop balances
 * only the alternate screen's push and the main screen's push survives the
 * process, leaving the user's shell receiving kitty-encoded keys (#7779).
 *
 * No-op unless the fallback is registered (the protocol was detected as
 * supported), so it is safe to call unconditionally after the renderer has
 * subscribed its own exit teardown.
 */
export function deferKittyProtocolExitFallback(): void {
  if (!exitFallbackRegistered) {
    return;
  }
  process.removeListener('exit', disableProtocol);
  process.on('exit', disableProtocol);
}

/**
 * Explicitly disables the Kitty keyboard protocol. Should be called during
 * application cleanup before process.exit() to ensure the terminal is restored
 * even if the 'exit' event handler does not fire in time (e.g. on SIGKILL).
 * Must be called after the renderer has left the alternate screen so the pop
 * lands on the main screen's flag stack.
 */
export function disableKittyProtocol(): void {
  disableProtocol();
}

export function isKittyProtocolEnabled(): boolean {
  return mainScreenPushActive || alternateScreenPushActive;
}

export function isKittyProtocolSupported(): boolean {
  return protocolSupported;
}
