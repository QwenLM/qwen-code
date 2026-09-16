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

// Which screen buffer the terminal is currently showing, tracked from the
// real stdout byte stream (`ESC[?1049h` enters, `ESC[?1049l` leaves). This is
// ground truth for deciding which buffer a pop would land on: unlike module
// bookkeeping it cannot drift from what the terminal actually did.
let alternateScreenCurrent = false;
// Set by disableProtocol() while the alternate screen is still current: the
// stdout hook writes the deferred main-screen pop immediately after it
// forwards the `ESC[?1049l` write (see installStdoutHook).
let mainPopDeferredUntilLeave = false;

const KITTY_KEYBOARD_PUSH = '\x1b[>1u';
const KITTY_KEYBOARD_POP = '\x1b[<u';
const ALT_SCREEN_ENTER = '\x1b[?1049h';
const ALT_SCREEN_LEAVE = '\x1b[?1049l';
// The common prefix of the enter/leave sequences; a write ending with a
// prefix of it may complete the sequence on the next write.
const ALT_SCREEN_PREFIX = '\x1b[?1049';

function enableProtocol(): void {
  installStdoutHook();
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

          // Last-resort fallback: if the process exits without running the
          // async cleanup chain (e.g. a direct process.exit() on a crash
          // path), the 'exit' event still fires and restores the terminal.
          // The fallback is buffer-aware (see disableProtocol): while the
          // alternate screen is current it defers its pop onto the
          // alternate-screen leave write observed by the stdout hook, so the
          // pop lands on the main screen even though native 'exit'
          // listeners always run before Ink's signal-exit teardown (#7779).
          process.on('exit', disableProtocol);
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
  if (alternateScreenCurrent) {
    // The alternate screen is still current. Every Node exit route fires
    // native 'exit' listeners before Ink's teardown (a signal-exit callback
    // that writes `ESC[?1049l`) runs — probe-verified for both the
    // process.emit('exit') and the process.exit() routes — so writing the
    // pop now would land on the alternate buffer's stack and leave the main
    // screen's push active after exit: the user's shell would keep
    // receiving kitty escape codes (#7779). Defer instead: the stdout hook
    // writes this pop immediately after the leave write is forwarded — the
    // first moment the pop provably lands on the main screen — and heals a
    // still-active alternate-screen push just before that write. Anchoring
    // to the bytes themselves makes the fallback independent of listener
    // registration order. (signal-exit's `alwaysLast` cannot help here:
    // the tree carries two mutually unaware signal-exit majors.)
    mainPopDeferredUntilLeave = true;
    return;
  }
  if (mainScreenPushActive) {
    process.stdout.write(KITTY_KEYBOARD_POP);
    mainScreenPushActive = false;
  }
  // Once the alternate screen has been left, that buffer is no longer shown
  // and the hook has already popped a dangling push at leave time, so there
  // is nothing else to balance here.
  alternateScreenPushActive = false;
}

// Teardown ordering cannot be won through listener registration order: Ink
// leaves the alternate screen from a signal-exit callback, and on every exit
// route Node fires native 'exit' listeners *before* signal-exit callbacks.
// Instead of racing for a listener position, the detector watches the
// terminal byte stream itself and anchors the pops to the alternate-screen
// leave write, wherever it comes from:
//   - just before `ESC[?1049l` is forwarded, a still-active alternate-screen
//     push is popped (a pop must land while its buffer is current);
//   - just after it, a pop deferred by disableProtocol() is written (it then
//     lands on the main screen).
// The hook is installed at detection time, before Ink's render and the app's
// output wrappers (synchronized output, redraw optimizer, resize reflow), so
// it is the innermost stdout.write wrapper: it observes the final bytes on
// their way out, and its injected pops go straight to the stream.
let stdoutHookInstalled = false;
let passthroughWrite:
  | ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => boolean)
  | undefined;

function writeInjected(sequence: string): void {
  // Best-effort: stdout may already be failing during crash teardown.
  try {
    passthroughWrite?.(sequence);
  } catch {
    // Ignore — matching Ink's own best-effort teardown writes.
  }
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    // Latin-1 keeps the byte <-> char index mapping bijective for the
    // ASCII escape sequences we scan for.
    return Buffer.from(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength,
    ).toString('latin1');
  }
  return String(chunk);
}

function mayContainAltScreenSwitch(chunk: unknown): boolean {
  if (typeof chunk === 'string') {
    return chunk.includes(ALT_SCREEN_PREFIX);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength,
    ).includes(ALT_SCREEN_PREFIX);
  }
  return String(chunk).includes(ALT_SCREEN_PREFIX);
}

function endsWithPartialAltScreenPrefix(chunk: string | Uint8Array): boolean {
  const max = Math.min(chunk.length, ALT_SCREEN_PREFIX.length);
  for (let length = max; length > 0; length--) {
    let matches = true;
    for (let i = 0; i < length; i++) {
      const element =
        typeof chunk === 'string'
          ? chunk.charCodeAt(chunk.length - length + i)
          : chunk[chunk.length - length + i]!;
      if (element !== ALT_SCREEN_PREFIX.charCodeAt(i)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

interface AltScreenMark {
  leave: boolean;
  index: number;
}

function altScreenMarks(text: string): AltScreenMark[] {
  const marks: AltScreenMark[] = [];
  let index = 0;
  for (;;) {
    const enter = text.indexOf(ALT_SCREEN_ENTER, index);
    const leave = text.indexOf(ALT_SCREEN_LEAVE, index);
    if (enter === -1 && leave === -1) {
      return marks;
    }
    if (leave === -1 || (enter !== -1 && enter < leave)) {
      marks.push({ leave: false, index: enter });
      index = enter + ALT_SCREEN_ENTER.length;
    } else {
      marks.push({ leave: true, index: leave });
      index = leave + ALT_SCREEN_LEAVE.length;
    }
  }
}

function partialAltScreenPrefixLength(text: string): number {
  // Longest suffix of `text` that is a proper prefix of the watched
  // sequences — the bytes a later write could complete into one.
  const max = Math.min(text.length, ALT_SCREEN_PREFIX.length);
  for (let length = max; length > 0; length--) {
    if (ALT_SCREEN_PREFIX.startsWith(text.slice(text.length - length))) {
      return length;
    }
  }
  return 0;
}

function installStdoutHook(): void {
  if (stdoutHookInstalled || !process.stdout?.write) {
    return;
  }
  stdoutHookInstalled = true;
  passthroughWrite = process.stdout.write.bind(
    process.stdout,
  ) as typeof passthroughWrite;
  let carry = '';

  const hookedWrite = function (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const encoding =
      typeof encodingOrCallback === 'function' ? undefined : encodingOrCallback;
    const writeCallback =
      typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;

    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      // Exotic chunk type: forward untouched (cannot scan it safely).
      return passthroughWrite!(
        chunk as string | Uint8Array,
        encoding,
        writeCallback,
      );
    }
    if (
      carry.length === 0 &&
      !mayContainAltScreenSwitch(chunk) &&
      !endsWithPartialAltScreenPrefix(chunk)
    ) {
      // Fast path: this write can neither contain nor complete a watched
      // sequence, so there is nothing to scan for or inject.
      return passthroughWrite!(
        chunk as string | Uint8Array,
        encoding,
        writeCallback,
      );
    }

    const text = chunkToText(chunk);
    const window = carry + text;
    // Sequences fully inside the carry prefix were already handled when
    // their bytes first passed through; only act on the ones this write
    // completes or contains.
    const carryLength = carry.length;
    const marks = altScreenMarks(window).filter(
      (mark) =>
        mark.index +
          (mark.leave ? ALT_SCREEN_LEAVE.length : ALT_SCREEN_ENTER.length) >
        carryLength,
    );

    // Update the current-buffer tracking from every switch in order; the
    // injections below only depend on the push bookkeeping.
    for (const mark of marks) {
      alternateScreenCurrent = !mark.leave;
    }
    // Keep the trailing partial-sequence bytes for the next write.
    carry = window.slice(window.length - partialAltScreenPrefixLength(window));

    const leaves = marks.filter((mark) => mark.leave);
    const needsInjection =
      leaves.length > 0 &&
      (alternateScreenPushActive || mainPopDeferredUntilLeave);

    if (!needsInjection) {
      return passthroughWrite!(
        chunk as string | Uint8Array,
        encoding,
        writeCallback,
      );
    }

    // Split the chunk at each leave so the pops bracket the exact
    // `ESC[?1049l` bytes. The original callback (if any) is attached to the
    // final forwarded piece. For string chunks the pieces keep the encoding
    // (escape sequences are ASCII, so the split points never divide a
    // multi-byte character); for byte chunks, byte slices are forwarded.
    // Latin-1 decoding keeps the char index of the escape scan identical to
    // the byte index.
    const bytes = chunk instanceof Uint8Array ? chunk : undefined;
    const forwardPiece = (
      from: number,
      to: number | undefined,
      cb?: (error?: Error | null) => void,
    ): boolean => {
      if (bytes) {
        return passthroughWrite!(bytes.subarray(from, to ?? bytes.length), cb);
      }
      return passthroughWrite!(text.slice(from, to) as string, encoding, cb);
    };

    let cursor = 0; // index into this chunk
    let result = true;
    let straddledLeave = false;
    for (const leave of leaves) {
      const at = leave.index - carryLength;
      if (at < 0) {
        // The sequence straddles two writes; its leading bytes already went
        // out, so injecting before them is impossible without corrupting
        // the stream. Skip the pre-leave pop for this leave only — the
        // deferred main-screen pop is still resolved after the tail.
        straddledLeave = true;
        continue;
      }
      if (at > cursor) {
        result = forwardPiece(cursor, at);
      }
      if (alternateScreenPushActive) {
        writeInjected(KITTY_KEYBOARD_POP);
        alternateScreenPushActive = false;
      }
      result = forwardPiece(at, at + ALT_SCREEN_LEAVE.length);
      if (mainPopDeferredUntilLeave) {
        mainPopDeferredUntilLeave = false;
        if (mainScreenPushActive) {
          writeInjected(KITTY_KEYBOARD_POP);
          mainScreenPushActive = false;
        }
      }
      cursor = at + ALT_SCREEN_LEAVE.length;
    }
    if (text.length > cursor || writeCallback) {
      result = forwardPiece(cursor, undefined, writeCallback);
    }
    if (straddledLeave && mainPopDeferredUntilLeave) {
      // A leave completed across the write boundary: the main screen is
      // current again once this write lands.
      mainPopDeferredUntilLeave = false;
      if (mainScreenPushActive) {
        writeInjected(KITTY_KEYBOARD_POP);
        mainScreenPushActive = false;
      }
    }
    return result;
  } as typeof process.stdout.write;

  process.stdout.write = hookedWrite;
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
 * unconditionally on teardown paths (including non-VP runs). If a crash path
 * skips this call, the stdout hook pops the dangling push just before the
 * `ESC[?1049l` write goes out (see installStdoutHook).
 */
export function popKittyProtocolFlags(): void {
  if (alternateScreenPushActive) {
    process.stdout.write(KITTY_KEYBOARD_POP);
    alternateScreenPushActive = false;
  }
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
