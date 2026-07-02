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

/**
 * Upper bound on an SGR mouse sequence's length while still incomplete. SGR
 * sequences (`\x1b[<btn;col;rowM`) are short; once a buffer exceeds this
 * without a terminator it is treated as garbage and abandoned so it doesn't
 * swallow real input. Shared by isIncompleteMouseSequence and the SGR
 * reassembly buffer in KeypressContext.
 */
export const MAX_SGR_MOUSE_SEQUENCE_LENGTH = 50;

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
    // SGR ends with 'm' or 'M'. Cap the length to fail garbage early.
    return (
      !/[mM]/.test(buffer) && buffer.length < MAX_SGR_MOUSE_SEQUENCE_LENGTH
    );
  }
  // Prefix of the prefix (e.g. "ESC" or "ESC [")
  return true;
}

/**
 * Mouse tracking level:
 * - `'button'` (`?1002h`): button-event tracking — presses, releases, wheel,
 *   and motion *while a button is held down* (drag). Does NOT report bare
 *   hover. This is the cheaper mode used by scroll/drag consumers.
 * - `'any'` (`?1003h`): any-event tracking — everything `'button'` reports
 *   plus bare pointer motion (hover) with no button down. Required for
 *   hover highlighting; the cost is a continuous stream of motion events and
 *   suppression of the terminal's native click-drag text selection (holding
 *   Shift/Option lets the user select text regardless).
 *
 * `?1006h` = SGR extended coordinates (handles cols/rows beyond 223), enabled
 * for both levels. Modes are sent together — most terminals ignore unknown
 * modes silently. 1002 and 1003 are mutually exclusive on the terminal, so
 * switching levels must disable the old one (see useMouseEvents).
 */
export type MouseTracking = 'button' | 'any';

const ENABLE_SGR_MOUSE: Record<MouseTracking, string> = {
  button: '\x1b[?1002h\x1b[?1006h',
  any: '\x1b[?1003h\x1b[?1006h',
};
const DISABLE_SGR_MOUSE: Record<MouseTracking, string> = {
  button: '\x1b[?1006l\x1b[?1002l',
  any: '\x1b[?1006l\x1b[?1003l',
};

export function enableMouseEvents(
  stdout: NodeJS.WriteStream,
  tracking: MouseTracking = 'button',
): void {
  stdout.write(ENABLE_SGR_MOUSE[tracking]);
}

export function disableMouseEvents(
  stdout: NodeJS.WriteStream,
  tracking: MouseTracking = 'button',
): void {
  stdout.write(DISABLE_SGR_MOUSE[tracking]);
}
