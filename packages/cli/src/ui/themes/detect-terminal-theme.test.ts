/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectTerminalBackground,
  parseColorFGBG,
} from './detect-terminal-theme.js';
import { PassThrough } from 'node:stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake TTY stdin that supports setRawMode. */
function createMockStdin() {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
    fd: 0;
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (mode: boolean) => void;
  };
  stream.fd = 0 as const;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = vi.fn((mode: boolean) => {
    stream.isRaw = mode;
  });
  return stream;
}

/** Create a fake TTY stdout. */
function createMockStdout() {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream & {
    fd: 1;
    isTTY: boolean;
  };
  stream.fd = 1 as const;
  stream.isTTY = true;
  return stream;
}

/**
 * Simulate a terminal replying with an OSC 11 response after a short delay.
 * Intercepts the query write on stdout, then pushes the response to stdin.
 */
function simulateOSC11Response(
  stdin: ReturnType<typeof createMockStdin>,
  stdout: ReturnType<typeof createMockStdout>,
  r: string,
  g: string,
  b: string,
) {
  stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('\x1b]11;?')) {
      // Reply after a tiny delay to simulate real terminal round-trip.
      setTimeout(() => {
        (stdin as unknown as PassThrough).push(
          Buffer.from(`\x1b]11;rgb:${r}/${g}/${b}\x07`),
        );
      }, 5);
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseColorFGBG
// ---------------------------------------------------------------------------

describe('parseColorFGBG', () => {
  it('returns dark for black background (index 0)', () => {
    expect(parseColorFGBG('15;0')).toBe('dark');
  });

  it('returns light for white background (index 7)', () => {
    expect(parseColorFGBG('0;7')).toBe('light');
  });

  it('returns dark for dark-gray background (index 8)', () => {
    expect(parseColorFGBG('15;8')).toBe('dark');
  });

  it('returns light for bright white (index 15)', () => {
    expect(parseColorFGBG('0;15')).toBe('light');
  });

  it('handles three-component format (fg;extra;bg)', () => {
    expect(parseColorFGBG('15;0;7')).toBe('light');
    expect(parseColorFGBG('7;0;0')).toBe('dark');
  });

  it('returns undefined for empty string', () => {
    expect(parseColorFGBG('')).toBeUndefined();
  });

  it('returns undefined for non-numeric values', () => {
    expect(parseColorFGBG('abc;xyz')).toBeUndefined();
  });

  it('returns undefined for out-of-range values', () => {
    expect(parseColorFGBG('0;16')).toBeUndefined();
    expect(parseColorFGBG('0;-1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectTerminalBackground — OSC 11
// ---------------------------------------------------------------------------

describe('detectTerminalBackground', () => {
  describe('OSC 11 query', () => {
    it('returns dark for black background (16-bit)', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();
      simulateOSC11Response(stdin, stdout, '0000', '0000', '0000');

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        timeoutMs: 500,
      });

      expect(result).toBe('dark');
    });

    it('returns light for white background (16-bit)', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();
      simulateOSC11Response(stdin, stdout, 'ffff', 'ffff', 'ffff');

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        timeoutMs: 500,
      });

      expect(result).toBe('light');
    });

    it('returns dark for a dark gray background (8-bit)', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();
      simulateOSC11Response(stdin, stdout, '1a', '1a', '2e');

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        timeoutMs: 500,
      });

      expect(result).toBe('dark');
    });

    it('returns light for a pastel background (8-bit)', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();
      simulateOSC11Response(stdin, stdout, 'f0', 'f0', 'f0');

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        timeoutMs: 500,
      });

      expect(result).toBe('light');
    });

    it('handles mid-luminance boundary (just above 0.5 = light)', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();
      // Pure green at ~72% luminance weight: rgb(00,b5,00)
      // Luminance = 0.7152 * 0xb5 / 0xff ≈ 0.506 → light
      simulateOSC11Response(stdin, stdout, '00', 'b5', '00');

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        timeoutMs: 500,
      });

      expect(result).toBe('light');
    });

    it('restores stdin raw mode after detection', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();
      simulateOSC11Response(stdin, stdout, 'ffff', 'ffff', 'ffff');

      await detectTerminalBackground({ stdin, stdout, timeoutMs: 500 });

      // setRawMode should have been called with true (enter) then false (restore)
      expect(stdin.setRawMode).toHaveBeenCalledWith(true);
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(stdin.isRaw).toBe(false);
    });

    it('falls back gracefully when setRawMode throws', async () => {
      const stdin = createMockStdin();
      stdin.setRawMode = vi.fn(() => {
        throw new Error('not supported');
      });
      const stdout = createMockStdout();

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        timeoutMs: 50,
        env: { COLORFGBG: '0;7' },
      });

      // Should fall through to COLORFGBG
      expect(result).toBe('light');
    });

    it('OSC 11 takes priority over COLORFGBG', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();
      // OSC 11 says light, COLORFGBG says dark
      simulateOSC11Response(stdin, stdout, 'ffff', 'ffff', 'ffff');

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        timeoutMs: 500,
        env: { COLORFGBG: '15;0' },
      });

      expect(result).toBe('light');
    });

    it('falls back when terminal does not respond (timeout)', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();
      // No OSC 11 response simulated — will time out.

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        timeoutMs: 50,
        env: {},
      });

      expect(result).toBe('dark');
    });
  });

  describe('non-TTY fallback', () => {
    it('skips OSC 11 when stdin is not a TTY', async () => {
      const stdin = createMockStdin();
      stdin.isTTY = false;
      const stdout = createMockStdout();

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        env: { COLORFGBG: '0;15' },
      });

      expect(result).toBe('light');
      // setRawMode should never have been called.
      expect(stdin.setRawMode).not.toHaveBeenCalled();
    });

    it('skips OSC 11 when stdout is not a TTY', async () => {
      const stdin = createMockStdin();
      const stdout = createMockStdout();
      stdout.isTTY = false;

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        env: {},
      });

      expect(result).toBe('dark');
    });
  });

  describe('COLORFGBG fallback', () => {
    it('uses COLORFGBG when OSC 11 is unavailable', async () => {
      const stdin = createMockStdin();
      stdin.isTTY = false;
      const stdout = createMockStdout();

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        env: { COLORFGBG: '15;0' },
      });

      expect(result).toBe('dark');
    });

    it('returns light from COLORFGBG', async () => {
      const stdin = createMockStdin();
      stdin.isTTY = false;
      const stdout = createMockStdout();

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        env: { COLORFGBG: '0;7' },
      });

      expect(result).toBe('light');
    });
  });

  describe('default fallback', () => {
    it('returns dark when no detection method succeeds', async () => {
      const stdin = createMockStdin();
      stdin.isTTY = false;
      const stdout = createMockStdout();
      stdout.isTTY = false;

      const result = await detectTerminalBackground({
        stdin,
        stdout,
        env: {},
      });

      expect(result).toBe('dark');
    });
  });
});
