/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inspired by gemini-cli's MouseContext (Google LLC, Apache-2.0) but
 * collapsed for our single-consumer case: enable SGR mouse mode on
 * mount, parse stdin events, call the handler, restore on unmount.
 */

import { useEffect, useRef } from 'react';
import { useStdin, useStdout } from 'ink';
import {
  enableMouseEvents,
  disableMouseEvents,
  isIncompleteMouseSequence,
  parseMouseEvent,
  type MouseEvent,
} from '../utils/mouse.js';

const MAX_MOUSE_BUFFER_SIZE = 4096;
// Use the `\x1b` escape so the source survives transports that strip raw
// 0x1B bytes (terminal copies, code review tools, some linters). The
// raw form looks identical visually but `indexOf('', 1) === 1` would
// degrade the buffer scan to a one-byte step and the "drop garbage"
// branch could never run.
const ESC = '\x1b';

export type MouseHandler = (event: MouseEvent) => void;

/**
 * Subscribes to SGR/X11 mouse events from stdin while `isActive` is true.
 *
 * On activation: writes `?1002h ?1006h` to enable button-event tracking and
 * SGR coordinates, attaches a stdin listener, and feeds parsed events to
 * `handler`. On cleanup (or when `isActive` flips false): removes the
 * listener and writes `?1006l ?1002l` to restore the terminal.
 *
 * The handler is stored in a ref so callers don't need to memoize it.
 */
export function useMouseEvents(
  handler: MouseHandler,
  { isActive }: { isActive: boolean },
): void {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!isActive) return;
    if (!isRawModeSupported) return;

    setRawMode(true);
    enableMouseEvents(stdout);

    let buffer = '';
    const onData = (data: Buffer | string) => {
      buffer += typeof data === 'string' ? data : data.toString('utf-8');

      // Cap buffer growth on garbage input.
      if (buffer.length > MAX_MOUSE_BUFFER_SIZE) {
        buffer = buffer.slice(-MAX_MOUSE_BUFFER_SIZE);
      }

      while (buffer.length > 0) {
        const parsed = parseMouseEvent(buffer);
        if (parsed) {
          handlerRef.current(parsed.event);
          buffer = buffer.slice(parsed.length);
          continue;
        }
        if (isIncompleteMouseSequence(buffer)) {
          // Wait for more bytes from stdin.
          break;
        }
        // Not a valid sequence at the start and not waiting for more —
        // skip past it to the next possible ESC, otherwise drop.
        const nextEsc = buffer.indexOf(ESC, 1);
        if (nextEsc !== -1) {
          buffer = buffer.slice(nextEsc);
        } else {
          buffer = '';
          break;
        }
      }
    };

    stdin.on('data', onData);

    // Belt-and-braces: if the process exits without React unmounting us
    // (Ctrl+C → exit, SIGTERM, parent killed), the React cleanup below
    // never runs and the terminal stays in SGR mouse-tracking mode after
    // qwen exits — wheel events would be echoed as literal escape
    // sequences. Hook `exit` to write the disable seq one more time as
    // a fallback. Node never throws from an `exit` listener, so even if
    // stdout is broken (EPIPE) the process still terminates cleanly.
    const onExit = () => {
      disableMouseEvents(stdout);
    };
    process.on('exit', onExit);

    return () => {
      process.removeListener('exit', onExit);
      stdin.removeListener('data', onData);
      disableMouseEvents(stdout);
    };
  }, [isActive, stdin, stdout, setRawMode, isRawModeSupported]);
}
