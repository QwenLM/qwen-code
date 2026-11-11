/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const ESC = '\u001B';
export const SGR_EVENT_PREFIX = `${ESC}[<`;
export const X11_EVENT_PREFIX = `${ESC}[M`;

// eslint-disable-next-line no-control-regex
export const SGR_MOUSE_REGEX = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/; // SGR mouse events
// X11 is ESC [ M followed by 3 bytes.
// eslint-disable-next-line no-control-regex
export const X11_MOUSE_REGEX = /^\x1b\[M([\s\S]{3})/;

export function couldBeSGRMouseSequence(buffer: string): boolean {
  if (buffer.length === 0) return true;
  // Check if buffer is a prefix of a mouse sequence starter
  if (SGR_EVENT_PREFIX.startsWith(buffer)) return true;
  // Check if buffer is a mouse sequence prefix
  if (buffer.startsWith(SGR_EVENT_PREFIX)) return true;

  return false;
}

export function couldBeMouseSequence(buffer: string): boolean {
  if (buffer.length === 0) return true;

  // Check SGR prefix
  if (
    SGR_EVENT_PREFIX.startsWith(buffer) ||
    buffer.startsWith(SGR_EVENT_PREFIX)
  )
    return true;
  // Check X11 prefix
  if (
    X11_EVENT_PREFIX.startsWith(buffer) ||
    buffer.startsWith(X11_EVENT_PREFIX)
  )
    return true;

  return false;
}
