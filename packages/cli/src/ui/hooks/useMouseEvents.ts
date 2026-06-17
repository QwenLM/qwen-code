/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inspired by gemini-cli's MouseContext (Google LLC, Apache-2.0) but
 * collapsed for our single-consumer case: enable SGR mouse mode on
 * mount, parse mouse sequences out of ink's input pipeline, call the
 * handler, restore on unmount.
 */

import { useEffect, useRef } from 'react';
import { writeSync } from 'node:fs';
import { useStdin, useStdout, useInput } from 'ink';
import {
  enableMouseEvents,
  disableMouseEvents,
  DISABLE_SGR_MOUSE,
  parseSGRMouseEvent,
  type MouseEvent,
} from '../utils/mouse.js';

// Use the `\x1b` escape so the source survives transports that strip raw
// 0x1B bytes (terminal copies, code review tools, some linters).
const ESC = '\x1b';

export type MouseHandler = (event: MouseEvent) => void;

/**
 * Subscribes to SGR mouse events while `isActive` is true.
 *
 * On activation: writes `?1002h ?1006h` to enable button-event tracking and
 * SGR coordinates, then parses mouse sequences delivered through ink's own
 * input pipeline. On cleanup (or when `isActive` flips false): writes
 * `?1006l ?1002l` to restore the terminal.
 *
 * Why not a dedicated `stdin.on('data')` listener: attaching a `data`
 * listener switches stdin into flowing mode, which drains the buffer before
 * ink's `readable` + `stdin.read()` reader (App.js) can consume it — every
 * keystroke routed through `useInput` would be silently starved while mouse
 * mode is active. Instead we hook ink's `useInput`, which already owns the
 * single stdin reader. ink's input parser captures a full SGR sequence
 * (`ESC [ < … M/m`) as one CSI event and hands it to the handler with the
 * leading ESC stripped (use-input strips a leading `\x1b`), so we re-prepend
 * it before parsing. Non-mouse input does not match and is ignored; ink
 * still routes the same input to the app's other `useInput` handlers, so
 * keyboard navigation is unaffected.
 *
 * Note: only SGR mode (`?1006h`, which we enable) is parsed via this path —
 * we call `parseSGRMouseEvent` directly rather than `parseMouseEvent` (which
 * also tries the X11 fallback). X11 is unwanted here: ink's CSI parser
 * mangles a real `ESC [ M` + 3-byte sequence anyway, and a literal X11 prefix
 * arriving via pasted text could otherwise misfire a spurious mouse event.
 * SGR is the encoding modern terminals emit once `?1006h` is set.
 *
 * The handler is stored in a ref so callers don't need to memoize it.
 */
export function useMouseEvents(
  handler: MouseHandler,
  { isActive }: { isActive: boolean },
): void {
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const enabled = isActive && isRawModeSupported;

  useEffect(() => {
    if (!enabled) return;

    enableMouseEvents(stdout);

    // Belt-and-braces: if the process exits without React unmounting us
    // (Ctrl+C → exit, SIGTERM, parent killed), the React cleanup below
    // never runs and the terminal stays in SGR mouse-tracking mode after
    // qwen exits — wheel events would be echoed as literal escape
    // sequences. Hook `exit` to write the disable seq one more time as
    // a fallback. Use writeSync(fd=1) instead of stdout.write because
    // during the `exit` event the event loop is stopped and async writes
    // never reach the terminal — leaving the terminal stuck in SGR mouse
    // mode (mouse unusable after qwen exits).
    const onExit = () => {
      try {
        writeSync(1, DISABLE_SGR_MOUSE);
      } catch {
        // fd 1 may already be closed (EPIPE, parent killed), ignore
      }
    };
    process.on('exit', onExit);

    return () => {
      process.removeListener('exit', onExit);
      disableMouseEvents(stdout);
    };
  }, [enabled, stdout]);

  useInput(
    (input) => {
      // ink hands us one escape sequence per call, with the leading ESC
      // stripped — re-prepend it so the SGR mouse regex matches.
      let buffer = input.startsWith(ESC) ? input : ESC + input;
      while (buffer.length > 0) {
        const parsed = parseSGRMouseEvent(buffer);
        if (!parsed) break;
        handlerRef.current(parsed.event);
        buffer = buffer.slice(parsed.length);
      }
    },
    { isActive: enabled },
  );
}
