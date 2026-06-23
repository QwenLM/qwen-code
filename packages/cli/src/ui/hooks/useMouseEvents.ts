/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inspired by gemini-cli's MouseContext (Google LLC, Apache-2.0) but
 * collapsed for our single-consumer case: enable SGR mouse mode on
 * mount, parse mouse sequences out of the KeypressContext pipeline,
 * call the handler, restore on unmount.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useStdin, useStdout } from 'ink';
import {
  enableMouseEvents,
  disableMouseEvents,
  type MouseEvent,
} from '../utils/mouse.js';
import { useKeypressContext } from '../contexts/KeypressContext.js';

export type MouseHandler = (event: MouseEvent) => void;

/**
 * Subscribes to SGR mouse events while `isActive` is true.
 *
 * On activation: writes `?1002h ?1006h` to enable button-event tracking and
 * SGR coordinates. KeypressContext's readline pipeline receives the SGR
 * fragments, reconstructs the full sequence, parses it, and forwards the
 * parsed MouseEvent to subscribers registered via `subscribeMouse`. On
 * cleanup (or when `isActive` flips false): writes `?1006l ?1002l` to
 * restore the terminal.
 *
 * Earlier versions used ink's `useInput` to receive mouse events, but
 * readline's `emitKeypressEvents` drains stdin in flowing mode before
 * ink's `readable` + `stdin.read()` reader can consume it — useInput
 * never fires when KeypressContext is active. The current approach routes
 * mouse events through the same readline pipeline as keyboard input.
 *
 * The handler is stored in a ref so callers don't need to memoize it.
 */
export function useMouseEvents(
  handler: MouseHandler,
  { isActive }: { isActive: boolean },
): void {
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const { subscribeMouse, unsubscribeMouse } = useKeypressContext();

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const enabled = isActive && isRawModeSupported;

  useEffect(() => {
    if (!enabled) return;

    enableMouseEvents(stdout);

    const onExit = () => {
      disableMouseEvents(stdout);
    };
    process.on('exit', onExit);

    return () => {
      process.removeListener('exit', onExit);
      disableMouseEvents(stdout);
    };
  }, [enabled, stdout]);

  const mouseCallback = useCallback((event: MouseEvent) => {
    handlerRef.current(event);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    subscribeMouse(mouseCallback);
    return () => unsubscribeMouse(mouseCallback);
  }, [enabled, subscribeMouse, unsubscribeMouse, mouseCallback]);
}
