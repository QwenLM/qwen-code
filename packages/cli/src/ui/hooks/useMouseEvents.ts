/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inspired by gemini-cli's MouseContext (Google LLC, Apache-2.0): enable SGR
 * mouse mode while at least one subscriber is active, parse mouse sequences
 * out of the KeypressContext pipeline, call each handler, restore on cleanup.
 */

import { useContext, useEffect, useRef, useCallback } from 'react';
import { useStdin, useStdout } from 'ink';
import {
  enableMouseEvents,
  disableMouseEvents,
  type MouseEvent,
} from '../utils/mouse.js';
import { useKeypressContext } from '../contexts/KeypressContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';

export type MouseHandler = (event: MouseEvent) => void;

export interface MouseEventsOptions {
  /** Subscribe + enable SGR mouse mode only while this is true. */
  isActive: boolean;
  /**
   * Opt out of the VP gate. By default mouse tracking is enabled only in VP
   * mode (`ui.useTerminalBuffer`), so non-VP keeps native terminal scrollback.
   * Set true for surfaces that own the wheel regardless — e.g. the VP viewport
   * (ScrollableList) — where there is no main-screen native scrollback to
   * protect.
   */
  bypassVpGate?: boolean;
}

type MouseModeEntry = {
  refs: number;
};

const mouseModeRefs = new Map<NodeJS.WriteStream, MouseModeEntry>();

const disableAllMouseModes = () => {
  for (const stdout of mouseModeRefs.keys()) {
    disableMouseEvents(stdout);
  }
  mouseModeRefs.clear();
};

function acquireMouseMode(stdout: NodeJS.WriteStream): void {
  const entry = mouseModeRefs.get(stdout);
  if (entry) {
    entry.refs += 1;
    return;
  }

  enableMouseEvents(stdout);
  if (mouseModeRefs.size === 0) {
    process.on('exit', disableAllMouseModes);
  }
  mouseModeRefs.set(stdout, { refs: 1 });
}

function releaseMouseMode(stdout: NodeJS.WriteStream): void {
  const entry = mouseModeRefs.get(stdout);
  if (!entry) return;

  entry.refs -= 1;
  if (entry.refs <= 0) {
    mouseModeRefs.delete(stdout);
    disableMouseEvents(stdout);
    if (mouseModeRefs.size === 0) {
      process.removeListener('exit', disableAllMouseModes);
    }
  }
}

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
  { isActive, bypassVpGate = false }: MouseEventsOptions,
): void {
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const { subscribeMouse, unsubscribeMouse } = useKeypressContext();

  // VP gate: enabling SGR mouse tracking (?1002h) makes the host terminal stop
  // doing native scrollback on the wheel. That is only acceptable when the app
  // itself owns the wheel — i.e. in VP mode (ScrollableList) or on an
  // alternate-screen surface (a modal) that has no native scrollback to begin
  // with. On the non-VP main screen, holding mouse tracking just hijacks the
  // wheel (Terminal.app diverts it away from scrollback), so by DEFAULT mouse
  // tracking is denied outside VP. Surfaces that legitimately consume the wheel
  // pass `bypassVpGate` to opt in. This keeps the non-VP transcript scrollable
  // no matter how many click/hover subscribers are added later.
  const settings = useContext(SettingsContext);
  const isVpMode = settings?.merged.ui?.useTerminalBuffer ?? false;
  const vpGateOpen = isVpMode || bypassVpGate;

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const enabled = isActive && isRawModeSupported && vpGateOpen;

  useEffect(() => {
    if (!enabled) return;

    acquireMouseMode(stdout);

    return () => {
      releaseMouseMode(stdout);
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
