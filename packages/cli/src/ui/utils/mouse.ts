/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted from gemini-cli (Google LLC, Apache-2.0):
 * packages/cli/src/ui/utils/mouse.ts + utils/input.ts. Trimmed to the
 * subset the virtual-viewport scroll path needs (SGR + X11 parsing,
 * incomplete-sequence detection, enable/disable helpers).
 */

// `\x1b` text escape rather than the raw 0x1B byte — the byte form is
// fragile against transports that silently strip control chars (terminal
// copies, some code-review viewers, certain linters). A previous draft
// had the raw byte and was caught by review.
const ESC = '\x1b';

export const SGR_EVENT_PREFIX = `${ESC}[<`;
export const X11_EVENT_PREFIX = `${ESC}[M`;

// eslint-disable-next-line no-control-regex
export const SGR_MOUSE_REGEX = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/;
// eslint-disable-next-line no-control-regex
export const X11_MOUSE_REGEX = /^\x1b\[M([\s\S]{3})/;

export type MouseEventName =
  | 'left-press'
  | 'left-release'
  | 'right-press'
  | 'right-release'
  | 'middle-press'
  | 'middle-release'
  | 'scroll-up'
  | 'scroll-down'
  | 'scroll-left'
  | 'scroll-right'
  | 'move';

export interface MouseEvent {
  name: MouseEventName;
  col: number;
  row: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  button: 'left' | 'middle' | 'right' | 'none';
}

function getEventName(
  buttonCode: number,
  isRelease: boolean,
): MouseEventName | null {
  const isMove = (buttonCode & 32) !== 0;
  if (buttonCode === 66) return 'scroll-left';
  if (buttonCode === 67) return 'scroll-right';
  if ((buttonCode & 64) === 64) {
    return (buttonCode & 1) === 0 ? 'scroll-up' : 'scroll-down';
  }
  if (isMove) return 'move';
  const button = buttonCode & 3;
  const type = isRelease ? 'release' : 'press';
  switch (button) {
    case 0:
      return `left-${type}` as MouseEventName;
    case 1:
      return `middle-${type}` as MouseEventName;
    case 2:
      return `right-${type}` as MouseEventName;
    default:
      return null;
  }
}

function buttonFromCode(code: number): MouseEvent['button'] {
  switch (code & 3) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return 'none';
  }
}

export function parseSGRMouseEvent(
  buffer: string,
): { event: MouseEvent; length: number } | null {
  const match = buffer.match(SGR_MOUSE_REGEX);
  if (!match) return null;
  const buttonCode = parseInt(match[1], 10);
  const col = parseInt(match[2], 10);
  const row = parseInt(match[3], 10);
  const isRelease = match[4] === 'm';
  const name = getEventName(buttonCode, isRelease);
  if (!name) return null;
  return {
    event: {
      name,
      col,
      row,
      shift: (buttonCode & 4) !== 0,
      meta: (buttonCode & 8) !== 0,
      ctrl: (buttonCode & 16) !== 0,
      button: buttonFromCode(buttonCode),
    },
    length: match[0].length,
  };
}

export function parseX11MouseEvent(
  buffer: string,
): { event: MouseEvent; length: number } | null {
  const match = buffer.match(X11_MOUSE_REGEX);
  if (!match) return null;
  const b = match[1].charCodeAt(0) - 32;
  const col = match[1].charCodeAt(1) - 32;
  const row = match[1].charCodeAt(2) - 32;
  const shift = (b & 4) !== 0;
  const meta = (b & 8) !== 0;
  const ctrl = (b & 16) !== 0;
  const isMove = (b & 32) !== 0;
  const isWheel = (b & 64) !== 0;
  let name: MouseEventName | null = null;
  if (isWheel) {
    name = (b & 1) === 0 ? 'scroll-up' : 'scroll-down';
  } else if (isMove) {
    name = 'move';
  } else {
    const button = b & 3;
    // X11 reports a single release code (3) without specifying which
    // button. Map to 'left-release' as a best-effort guess; callers that
    // only care about scroll/drag won't be affected.
    if (button === 3) {
      name = 'left-release';
    } else if (button === 0) {
      name = 'left-press';
    } else if (button === 1) {
      name = 'middle-press';
    } else if (button === 2) {
      name = 'right-press';
    }
  }
  if (!name) return null;
  let button = buttonFromCode(b);
  if (name === 'left-release' && button === 'none') button = 'left';
  return {
    event: { name, col, row, shift, meta, ctrl, button },
    length: match[0].length,
  };
}

export function parseMouseEvent(
  buffer: string,
): { event: MouseEvent; length: number } | null {
  return parseSGRMouseEvent(buffer) || parseX11MouseEvent(buffer);
}

function couldBeMouseSequence(buffer: string): boolean {
  if (buffer.length === 0) return true;
  if (
    SGR_EVENT_PREFIX.startsWith(buffer) ||
    buffer.startsWith(SGR_EVENT_PREFIX)
  )
    return true;
  if (
    X11_EVENT_PREFIX.startsWith(buffer) ||
    buffer.startsWith(X11_EVENT_PREFIX)
  )
    return true;
  return false;
}

export function isIncompleteMouseSequence(buffer: string): boolean {
  if (!couldBeMouseSequence(buffer)) return false;
  if (parseMouseEvent(buffer)) return false;
  if (buffer.startsWith(X11_EVENT_PREFIX)) {
    return buffer.length < X11_EVENT_PREFIX.length + 3;
  }
  if (buffer.startsWith(SGR_EVENT_PREFIX)) {
    // SGR ends with 'm' or 'M'. Cap at 50 bytes to fail garbage early.
    return !/[mM]/.test(buffer) && buffer.length < 50;
  }
  // Prefix of the prefix (e.g. "ESC" or "ESC [")
  return true;
}

// `?1002h` = button-event tracking (presses, releases, drags, wheel).
// `?1006h` = SGR extended coordinates (handles cols/rows beyond 223).
// Sent together — most terminals ignore unknown modes silently.
const ENABLE_SGR_MOUSE = '\x1b[?1002h\x1b[?1006h';
export const DISABLE_SGR_MOUSE = '\x1b[?1006l\x1b[?1002l';

export function enableMouseEvents(stdout: NodeJS.WriteStream): void {
  stdout.write(ENABLE_SGR_MOUSE);
}

export function disableMouseEvents(stdout: NodeJS.WriteStream): void {
  stdout.write(DISABLE_SGR_MOUSE);
}
