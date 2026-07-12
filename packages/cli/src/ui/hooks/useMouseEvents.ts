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
  type MouseTracking,
} from '../utils/mouse.js';
import { useKeypressContext } from '../contexts/KeypressContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';

export type MouseHandler = (event: MouseEvent) => void;

export interface MouseEventsOptions {
  /** Subscribe + enable SGR mouse mode only while this is true. */
  isActive: boolean;
  /**
   * Tracking level to request. `'button'` (?1002h) reports press/drag/release;
   * `'any'` (?1003h) additionally reports bare motion, needed for hover. The
   * effective terminal level is the highest any active subscriber requests.
   */
  tracking?: MouseTracking;
  /**
   * Opt out of the VP gate. By default mouse tracking is enabled only in VP
   * mode (`ui.useTerminalBuffer`), so non-VP keeps native terminal scrollback.
   * Set true for surfaces that own the wheel regardless — e.g. the VP viewport
   * (ScrollableList) — where there is no main-screen native scrollback to
   * protect.
   */
  bypassVpGate?: boolean;
}

// Per-terminal reference counts, split by tracking level. The effective level
// is the highest requested: any active subscriber asking for 'any' (hover)
// upgrades the terminal to ?1003h; otherwise ?1002h. `active` records what is
// currently enabled on the terminal so a level switch disables the old mode
// before enabling the new one (1002 and 1003 are mutually exclusive).
type MouseModeEntry = {
  button: number;
  any: number;
  active: MouseTracking | null;
};

const mouseModeRefs = new Map<NodeJS.WriteStream, MouseModeEntry>();

function effectiveTracking(entry: MouseModeEntry): MouseTracking | null {
  if (entry.any > 0) return 'any';
  if (entry.button > 0) return 'button';
  return null;
}

// Bring the terminal's enabled mode in line with the desired effective level,
// writing escape sequences only when the level actually changes.
function reconcileMouseMode(
  stdout: NodeJS.WriteStream,
  entry: MouseModeEntry,
): void {
  const desired = effectiveTracking(entry);
  if (desired === entry.active) return;
  if (entry.active) disableMouseEvents(stdout, entry.active);
  if (desired) enableMouseEvents(stdout, desired);
  entry.active = desired;
}

const disableAllMouseModes = () => {
  for (const [stdout, entry] of mouseModeRefs) {
    if (entry.active) disableMouseEvents(stdout, entry.active);
  }
  mouseModeRefs.clear();
};

function acquireMouseMode(
  stdout: NodeJS.WriteStream,
  tracking: MouseTracking,
): void {
  let entry = mouseModeRefs.get(stdout);
  if (!entry) {
    if (mouseModeRefs.size === 0) {
      process.on('exit', disableAllMouseModes);
    }
    entry = { button: 0, any: 0, active: null };
    mouseModeRefs.set(stdout, entry);
  }
  entry[tracking] += 1;
  reconcileMouseMode(stdout, entry);
}

function releaseMouseMode(
  stdout: NodeJS.WriteStream,
  tracking: MouseTracking,
): void {
  const entry = mouseModeRefs.get(stdout);
  if (!entry) return;

  entry[tracking] = Math.max(0, entry[tracking] - 1);
  reconcileMouseMode(stdout, entry);

  if (entry.button === 0 && entry.any === 0) {
    mouseModeRefs.delete(stdout);
    if (mouseModeRefs.size === 0) {
      process.removeListener('exit', disableAllMouseModes);
    }
  }
}

/**
 * Subscribes to SGR mouse events while `isActive` is true.
 *
 * On activation: enables SGR mouse tracking at the requested `tracking` level
 * (`'button'` → `?1002h`, `'any'` → `?1003h` for hover) plus `?1006h` for SGR
 * coordinates. KeypressContext's readline pipeline receives the SGR fragments,
 * reconstructs the full sequence, parses it, and forwards the parsed
 * MouseEvent to subscribers registered via `subscribeMouse`. On cleanup (or
 * when `isActive` flips false): disables the mode to restore the terminal.
 * Reference counts are shared per terminal across all subscribers; the
 * effective level is the highest any active subscriber requests.
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
  { isActive, tracking = 'button', bypassVpGate = false }: MouseEventsOptions,
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

  // Never write SGR mouse-mode escapes (?1002h ?1006h) unless stdout is a TTY.
  // `isRawModeSupported` only reflects stdin; with stdout piped/redirected
  // (`qwen | tee log`) an active, raw-mode-capable surface — e.g. the non-TTY
  // transcript's focused ScrollableList (`bypassVpGate`) — would otherwise emit
  // raw control bytes into the captured output. Mirrors AlternateScreen's
  // `process.stdout.isTTY` guard so the non-TTY fallback stays byte-clean.
  const enabled =
    isActive && isRawModeSupported && vpGateOpen && Boolean(stdout.isTTY);

  useEffect(() => {
    if (!enabled) return;

    acquireMouseMode(stdout, tracking);

    return () => {
      releaseMouseMode(stdout, tracking);
    };
  }, [enabled, stdout, tracking]);

  const mouseCallback = useCallback((event: MouseEvent) => {
    handlerRef.current(event);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    subscribeMouse(mouseCallback);
    return () => unsubscribeMouse(mouseCallback);
  }, [enabled, subscribeMouse, unsubscribeMouse, mouseCallback]);
}
