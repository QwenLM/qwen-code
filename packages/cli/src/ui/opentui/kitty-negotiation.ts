/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Headless-safe kitty keyboard negotiation for the OpenTUI renderer.
 *
 * The @opentui framework enables the kitty keyboard protocol itself when
 * `useKittyKeyboard` is set, emitting `\x1b[?u` capability queries at
 * startup. Terminals (and PTY harnesses/CI) that never answer those queries
 * left the renderer's input negotiation in a state where legacy keystrokes
 * were not accepted at all (audit G-02). The CLI layer cannot reach into the
 * framework's negotiation, but it CAN decide whether kitty mode is switched
 * on in the first place: this probe mirrors the ink side's
 * `kittyProtocolDetector` approach — query once with a hard 200ms timeout —
 * and `opentui-entry` passes `useKittyKeyboard: null` when the terminal
 * does not answer, so legacy key input always works in headless/no-reply
 * environments (at the cost of kitty-only distinctions like Shift+Enter
 * reporting there — the same trade-off ink makes).
 *
 * The probe is detection-only: it never pushes kitty flags itself, so the
 * framework (or ink) remains the sole owner of the protocol flag stack.
 */

/** Minimal structural stdin surface the probe needs (EventEmitter-compatible). */
export interface ProbeStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
  on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  removeListener(
    event: 'data',
    listener: (data: Buffer | string) => void,
  ): unknown;
}

/** Minimal structural stdout surface the probe needs. */
export interface ProbeStdout {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface KittyProbeOptions {
  /** How long to wait for a terminal reply before giving up (default 200ms,
   *  matching ink's kittyProtocolDetector threshold). */
  timeoutMs?: number;
  /** Injectable for tests. */
  stdin?: ProbeStdin;
  stdout?: ProbeStdout;
  /** Late-reply drain window after settlement (default 50ms). */
  settleMs?: number;
}

const KITTY_QUERY = '\x1b[?u'; // progressive-enhancement query
const DEVICE_ATTRIBUTES_QUERY = '\x1b[c'; // primary DA liveness query

// Kitty answers CSI ? u with CSI ? <flags> u.
// eslint-disable-next-line no-control-regex
const KITTY_REPLY_RE = /\x1b\[\?\d*u/;
// Any primary-device-attributes reply (CSI ? … c) means a terminal answered
// but does not speak kitty.
// eslint-disable-next-line no-control-regex
const DA_REPLY_RE = /\x1b\[\?[0-9;]*c/;

/**
 * Resolves true when the terminal answers the kitty keyboard query within
 * the timeout. Resolves false on timeout, on a DA-only reply, or when
 * stdin/stdout is not a TTY (piped/headless runs never get kitty mode).
 */
export async function probeKittyKeyboardSupport(
  options?: KittyProbeOptions,
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 200;
  const settleMs = options?.settleMs ?? 50;
  const stdin = options?.stdin ?? process.stdin;
  const stdout = options?.stdout ?? process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    return false;
  }

  const originalRawMode = stdin.isRaw ?? false;
  if (!originalRawMode && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
  }

  return new Promise<boolean>((resolve) => {
    let buffer = '';
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      stdin.removeListener('data', onData);
      // Consume any late-arriving terminal replies briefly so they do not
      // leak into application input after we hand stdin back.
      const drain = (): void => {};
      stdin.on('data', drain);
      settleTimer = setTimeout(() => {
        stdin.removeListener('data', drain);
        if (!originalRawMode && typeof stdin.setRawMode === 'function') {
          stdin.setRawMode(false);
        }
        resolve(supported);
      }, settleMs);
      settleTimer.unref?.();
    };

    const onData = (data: Buffer | string): void => {
      buffer += data.toString();
      if (KITTY_REPLY_RE.test(buffer)) {
        finish(true);
        return;
      }
      if (DA_REPLY_RE.test(buffer)) {
        // A terminal answered, but it does not speak kitty.
        finish(false);
      }
    };

    stdin.on('data', onData);
    stdout.write(KITTY_QUERY);
    stdout.write(DEVICE_ATTRIBUTES_QUERY);
    timeoutId = setTimeout(() => finish(false), timeoutMs);
    timeoutId.unref?.();
  });
}
