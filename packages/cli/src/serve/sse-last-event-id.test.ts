/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stdioMocks = vi.hoisted(() => ({
  writeStderrLine: vi.fn(),
}));

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: stdioMocks.writeStderrLine,
}));

const { parseLastEventId } = await import('./sse-last-event-id.js');

/** The single line `parseLastEventId` logged, or `undefined` if it was silent. */
function loggedLine(): string | undefined {
  const calls = stdioMocks.writeStderrLine.mock.calls;
  return calls.length > 0 ? (calls[calls.length - 1][0] as string) : undefined;
}

describe('parseLastEventId', () => {
  beforeEach(() => {
    stdioMocks.writeStderrLine.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts "0" as a valid cursor (not a falsy reject)', () => {
    expect(parseLastEventId('0')).toBe(0);
    expect(stdioMocks.writeStderrLine).not.toHaveBeenCalled();
  });

  it('accepts a plain decimal id', () => {
    expect(parseLastEventId('42')).toBe(42);
    expect(stdioMocks.writeStderrLine).not.toHaveBeenCalled();
  });

  it.each(['1abc', '1.5', '-1', '0x10', '1e5', ' 7 '])(
    'rejects non-decimal %j with a log',
    (raw) => {
      expect(parseLastEventId(raw)).toBeUndefined();
      expect(loggedLine()).toContain('not a decimal integer');
    },
  );

  it('rejects the empty string SILENTLY (the common no-resume first connect)', () => {
    expect(parseLastEventId('')).toBeUndefined();
    expect(stdioMocks.writeStderrLine).not.toHaveBeenCalled();
  });

  it('rejects a non-string (undefined header) silently', () => {
    expect(parseLastEventId(undefined)).toBeUndefined();
    expect(stdioMocks.writeStderrLine).not.toHaveBeenCalled();
  });

  it('rejects a value past MAX_SAFE_INTEGER with a log', () => {
    const tooBig = String(Number.MAX_SAFE_INTEGER) + '0'; // pure digits, overflows
    expect(parseLastEventId(tooBig)).toBeUndefined();
    expect(loggedLine()).toContain('exceeds Number.MAX_SAFE_INTEGER');
  });

  it('threads the logPrefix into the rejection log', () => {
    parseLastEventId('nope', '/acp ');
    expect(loggedLine()).toContain('/acp ');
  });
});

describe('safeLogValue (exercised via parseLastEventId rejection logs)', () => {
  beforeEach(() => {
    stdioMocks.writeStderrLine.mockClear();
  });

  it('strips CR/LF (log-forging), ANSI ESC and NUL from the logged value', () => {
    parseLastEventId('1\r\nINJECTED\x1b[31m\x00x');
    const line = loggedLine() ?? '';
    expect(line).toContain('not a decimal integer');
    // No raw control characters survive into the log line.
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    // The ESC byte specifically is gone (its trailing "[31m" text is harmless).
    expect(line).not.toContain('\x1b');
  });

  it('truncates an over-long value to ~64 chars with an ellipsis', () => {
    const raw = 'z'.repeat(200); // non-decimal ⇒ takes the reject-with-log path
    parseLastEventId(raw);
    const line = loggedLine() ?? '';
    expect(line).toContain('…');
    // The clipped value is far shorter than the 200-char input.
    expect(line.length).toBeLessThan(raw.length);
  });
});
